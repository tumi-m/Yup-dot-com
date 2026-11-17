/**
 * Pictures into one PDF, a page per picture (a page per page of a TIFF).
 * JPEGs and PNGs go in as they are, or right-sized; other formats are
 * decoded to pixels first (decode.ts, tiff.ts). Only pdf-lib, the image
 * codec and the browser's decoders, so it runs in a Web Worker
 * (off-thread.ts) as well as here.
 */
import { PDFDocument, type PDFPage } from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { drawOrientedImage, imageSize, jpegOrientation, orientedSize } from "../images";
import { embedImage, embedPixels, type EmbeddedImage } from "../embed-image";
import { downsampleTarget } from "../../image-fit";
import { decodeBitmap, decodeSvg, type Frame, type Want } from "./decode";
import { sniffFormat, type ImageFormat } from "./formats";
import { tiffPages } from "./tiff";

export interface ImagesToPdfOptions {
  /** "fit" (a page the size of each picture) or "a4". */
  pageSize: string;
  /** In points. */
  margin: string;
}

/** A picture decoded already (on the page, for SVG and HEIC), with the file it came from. */
export interface DecodedImage {
  name: string;
  frames: Frame[];
  /** From a lossy photo format (HEIC). */
  lossy?: boolean;
}

export type ImageInput = File | DecodedImage;

/** How formats that need decoding become pixels, no more than `want` asks for; tests pass their own. */
export type Decoder = (bytes: Uint8Array, format: ImageFormat, name: string, want?: Want) => Promise<Frame>;

const A4 = { w: 595.28, h: 841.89 };
const MAX_PAGE_PT = 14400;

export const UNSUPPORTED = "use a JPG, PNG, WebP, GIF, BMP, TIFF, AVIF, HEIC or SVG image.";

const browserDecoder: Decoder = (bytes, format, name, want) =>
  format === "svg" ? decodeSvg(bytes, name) : decodeBitmap(bytes, format, name, want);

/** Lossy photo formats: what they decode to is never worth keeping lossless. */
const LOSSY = new Set<ImageFormat>(["webp", "avif", "heic"]);

/** Where a picture of `shown` size goes: the page's size and the rectangle it fills. */
function layout(opts: ImagesToPdfOptions, shown: { width: number; height: number }) {
  const margin = Number(opts.margin) || 0;
  let size: [number, number];
  let rect: { x: number; y: number; width: number; height: number };
  // The picture is right-sized for 300 DPI at its drawn size times this.
  let print = 1;
  if (opts.pageSize === "fit") {
    // 1 px = 1 pt, capped at the 200-inch page limit PDF viewers enforce.
    const scale = Math.min(1, (MAX_PAGE_PT - margin * 2) / Math.max(shown.width, shown.height));
    const w = shown.width * scale;
    const h = shown.height * scale;
    size = [w + margin * 2, h + margin * 2];
    rect = { x: margin, y: margin, width: w, height: h };
    // At 1 pt per pixel a phone photo makes a 42-inch page, which no one
    // prints or views at that size: size it for A4 paper instead.
    print = Math.min(1, A4.h / Math.max(w, h));
  } else {
    size = [A4.w, A4.h];
    const maxW = A4.w - margin * 2;
    const maxH = A4.h - margin * 2;
    const ratio = Math.min(maxW / shown.width, maxH / shown.height);
    const w = shown.width * ratio;
    const h = shown.height * ratio;
    rect = { x: (A4.w - w) / 2, y: (A4.h - h) / 2, width: w, height: h };
  }
  return { size, rect, print };
}

/** Adds the page for a picture of `shown` size. */
function placePage(out: PDFDocument, opts: ImagesToPdfOptions, shown: { width: number; height: number }) {
  const { size, rect, print } = layout(opts, shown);
  const page: PDFPage = out.addPage(size);
  return { page, rect, print };
}

/** The pixels an upright picture needs on its page (300 DPI there), for the decoder. */
export function wantFor(opts: ImagesToPdfOptions): Want {
  return (width, height) => {
    const { rect, print } = layout(opts, { width, height });
    return downsampleTarget(width, height, rect.width * print, rect.height * print);
  };
}

/** Size on the page in the image's stored orientation, for right-sizing. */
function fitFor(rect: { width: number; height: number }, orientation: number, print: number) {
  const sideways = orientation >= 5;
  return { widthPt: (sideways ? rect.height : rect.width) * print, heightPt: (sideways ? rect.width : rect.height) * print };
}

async function addFrame(out: PDFDocument, opts: ImagesToPdfOptions, frame: Frame, lossy = false) {
  const shown = orientedSize(frame, frame.orientation);
  const { page, rect, print } = placePage(out, opts, shown);
  // The pixels may be fewer than the layout size (a huge photo decoded
  // smaller, a drawn SVG): right-size against the pixels' own shape.
  const img = await embedPixels(out, frame.pixels, fitFor(rect, frame.orientation, print), lossy);
  drawOrientedImage(page, img, frame.orientation, rect);
}

export async function imagesToPdf(
  files: ImageInput[],
  opts: ImagesToPdfOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal,
  decode: Decoder = browserDecoder
): Promise<Uint8Array> {
  const out = await PDFDocument.create();

  for (const [i, file] of files.entries()) {
    stopIfAborted(signal);
    const label = files.length > 1 ? `Image ${i + 1} of ${files.length}` : "";
    if (label) onProgress?.(i / files.length, label);

    if (!(file instanceof Blob)) {
      for (const frame of file.frames) await addFrame(out, opts, frame, file.lossy);
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    const format = sniffFormat(data);
    if (!format) throw new Error(`${file.name}: ${UNSUPPORTED}`);

    if (format === "tiff") {
      const pages = await tiffPages(data, file.name);
      for (let p = 0; p < pages.count; p++) {
        stopIfAborted(signal);
        if (pages.count > 1) {
          onProgress?.((i + p / pages.count) / files.length, `${label ? `${label}, page` : "Page"} ${p + 1} of ${pages.count}`);
        }
        // One page of pixels at a time: it is let go once embedded.
        await addFrame(out, opts, pages.page(p));
      }
      continue;
    }
    if (format !== "jpeg" && format !== "png") {
      await addFrame(out, opts, await decode(data, format, file.name, wantFor(opts)), LOSSY.has(format));
      continue;
    }

    const size = imageSize(data, format);
    if (!size) throw new Error(`${file.name}: this image looks damaged.`);
    const orientation = format === "jpeg" ? jpegOrientation(data) : 1;
    const { page, rect, print } = placePage(out, opts, orientedSize(size, orientation));
    let img: EmbeddedImage;
    try {
      img = await embedImage(out, data, format, size, fitFor(rect, orientation, print));
    } catch {
      throw new Error(`${file.name}: this image looks damaged.`);
    }
    drawOrientedImage(page, img, orientation, rect);
  }
  return out.save();
}
