import {
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";

/** Identifies an image by its bytes, not its name: renamed files are common. */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  return null;
}

/**
 * EXIF orientation (1–8) of a JPEG, 1 when absent. Phone photos store pixels
 * sideways and rely on this tag; browsers honour it, so the PDF must too.
 */
export function jpegOrientation(bytes: Uint8Array): number {
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
      if (tiff + 8 > bytes.length) return 1;
      const little = view.getUint16(tiff) === 0x4949;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      if (ifd + 2 > bytes.length) return 1;
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > bytes.length) return 1;
        if (view.getUint16(entry, little) === 0x0112) {
          const value = view.getUint16(entry + 8, little);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    offset += 2 + length;
  }
  return 1;
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
  img: PDFImage,
  orientation: number,
  rect: { x: number; y: number; width: number; height: number }
) {
  const { x, y, width: w, height: h } = rect;
  if (orientation === 1 || orientation < 1 || orientation > 8) {
    page.drawImage(img, rect);
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
  const name = page.node.newXObject("Image", img.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...m[orientation]),
    drawObject(name),
    popGraphicsState()
  );
}
