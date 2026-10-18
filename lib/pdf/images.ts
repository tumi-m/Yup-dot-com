import {
  concatTransformationMatrix,
  degrees,
  drawImage,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";

/** Identifies an image by its bytes, not its name: renamed files are common. */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/** Pixel size of a JPEG or PNG as stored (before any EXIF rotation), or null if unreadable. */
export function imageSize(bytes: Uint8Array, kind: "png" | "jpeg"): { width: number; height: number } | null {
  if (kind === "png") {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width && height ? { width, height } : null;
  }
  const sof = jpegFrame(bytes);
  return sof && sof.width && sof.height ? { width: sof.width, height: sof.height } : null;
}

/** Colour channels of a JPEG: 1 grey, 3 colour, 4 CMYK; 0 if unreadable. */
export function jpegChannels(bytes: Uint8Array): number {
  return jpegFrame(bytes)?.channels ?? 0;
}

/** The JPEG's frame header (SOF): size and number of channels. */
function jpegFrame(bytes: Uint8Array): { width: number; height: number; channels: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 10 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++; // fill byte
      continue;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7), channels: bytes[offset + 9] };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    offset += 2 + view.getUint16(offset + 2);
  }
  return null;
}

/**
 * EXIF orientation (1–8) of a JPEG, 1 when absent. Phone photos store pixels
 * sideways and rely on this tag; browsers honour it, so the PDF must too.
 */
export function jpegOrientation(bytes: Uint8Array): number {
  const tag = orientationTag(bytes);
  if (!tag) return 1;
  const value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(tag.offset, tag.little);
  return value >= 1 && value <= 8 ? value : 1;
}

/**
 * A copy of a JPEG whose EXIF orientation reads 1 (upright), for decoders
 * that can't be told to keep the pixels as stored.
 */
export function withoutOrientation(bytes: Uint8Array): Uint8Array {
  // A fresh copy (a Node Buffer's slice() is a view).
  const copy = new Uint8Array(bytes);
  const tag = orientationTag(copy);
  if (tag) new DataView(copy.buffer).setUint16(tag.offset, 1, tag.little);
  return copy;
}

/** Where a JPEG's EXIF orientation value sits, or null when it has none. */
function orientationTag(bytes: Uint8Array): { offset: number; little: boolean } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    const length = view.getUint16(offset + 2);
    if (marker === 0xda || marker === 0xd9) break; // image data starts
    if (
      marker === 0xe1 &&
      offset + 10 <= bytes.length &&
      view.getUint32(offset + 4) === 0x45786966 && // "Exif"
      view.getUint16(offset + 8) === 0
    ) {
      const tiff = offset + 10;
      if (tiff + 8 > bytes.length) return null;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > bytes.length) return null;
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) return null;
        if (view.getUint16(entry, little) === 0x0112) return { offset: entry + 8, little };
      }
      return null;
    }
    offset += 2 + length;
  }
  return null;
}

/** Displayed size of an image once its EXIF orientation is applied. */
export function orientedSize(img: { width: number; height: number }, orientation: number) {
  return orientation >= 5 ? { width: img.height, height: img.width } : { width: img.width, height: img.height };
}

/**
 * Draws `img` so it appears upright in the rectangle (x, y, w, h) — w and h
 * being the displayed (oriented) size. Maps the image's unit square with a
 * matrix per EXIF orientation.
 */
export function drawOrientedImage(
  page: PDFPage,
  img: { ref: PDFRef },
  orientation: number,
  rect: { x: number; y: number; width: number; height: number }
) {
  const { x, y, width: w, height: h } = rect;
  const name = page.node.newXObject("Image", img.ref);
  if (!(orientation >= 2 && orientation <= 8)) {
    // Upright: the same operators as pdf-lib's page.drawImage.
    page.pushOperators(...drawImage(name, { x, y, width: w, height: h, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) }));
    return;
  }
  const m: Record<number, [number, number, number, number, number, number]> = {
    2: [-w, 0, 0, h, x + w, y],
    3: [-w, 0, 0, -h, x + w, y + h],
    4: [w, 0, 0, -h, x, y + h],
    5: [0, -h, -w, 0, x + w, y + h],
    6: [0, -h, w, 0, x, y + h],
    7: [0, h, w, 0, x, y],
    8: [0, h, -w, 0, x + w, y],
  };
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...m[orientation]),
    drawObject(name),
    popGraphicsState()
  );
}
