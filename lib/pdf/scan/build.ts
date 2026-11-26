/**
 * Scanned pages into one PDF. Each photo is flattened, filtered and turned
 * (page.ts), then laid out as JPG to PDF lays out pictures: the same page
 * sizes and placing (images-to-pdf layout), with Fit making a page the shape
 * of the paper at A4's height. One page is in memory at a time, so twenty
 * photos take no more than one.
 *
 * Colour and grey pages are JPEGs at 200 DPI on the page (a camera's noise
 * doesn't get sharper past that); Document pages are black and white at 300
 * DPI, stored losslessly at one bit a pixel, so text stays crisp and small.
 *
 * Only pdf-lib and the image codec, so it runs in a worker (off-thread.ts)
 * and in Node tests.
 */
import { PDFDocument } from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { decodeJpeg, encodeJpeg, type RawImage } from "../../image-codec";
import { embedPixels } from "../embed-image";
import { drawOrientedImage } from "../images";
import { layout } from "../images-to-pdf/index";
import { flatSize } from "./geometry";
import { flattenPage, type ScanOptions, type ScanPage } from "./page";

export { flattenPage, MAX_LONG, PAGE_SIZES, type ScanOptions, type ScanPage, type ScanPageSize } from "./page";

/** Fit pages are the paper's shape, this tall (A4). */
const FIT_LONG_PT = 841.89;
const PHOTO_DPI = 200;
const BW_DPI = 300;
/** MozJPEG quality for a scanned photo page: clean on paper, a few hundred KB. */
const SCAN_QUALITY = 82;

const sideways = (rotation: number) => Math.round(rotation / 90) % 2 !== 0;

/** The paper's shape as it will be shown (turned): Fit pages are that shape at A4's height. */
function shownShape(page: Omit<ScanPage, "image">, photo: { width: number; height: number }, fit: boolean) {
  const natural = flatSize(page.quad, photo.width, photo.height, Infinity);
  const [w, h] = sideways(page.rotation) ? [natural.height, natural.width] : [natural.width, natural.height];
  const scale = fit ? FIT_LONG_PT / Math.max(w, h) : 1;
  return { width: w * scale, height: h * scale };
}

async function pixelsOf(image: ScanPage["image"]): Promise<RawImage> {
  if (image instanceof Uint8Array) return decodeJpeg(image);
  if (typeof Blob !== "undefined" && image instanceof Blob) return decodeJpeg(new Uint8Array(await image.arrayBuffer()));
  return image as RawImage;
}

export async function buildScanPdf(
  pages: ScanPage[],
  opts: ScanOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!pages.length) throw new Error("Scan or add a page first.");
  const out = await PDFDocument.create();
  const layoutOpts = { pageSize: opts.pageSize, margin: "0" };
  for (const [i, page] of pages.entries()) {
    stopIfAborted(signal);
    onProgress?.(i / pages.length, `Page ${i + 1} of ${pages.length}`);
    let photo: RawImage;
    try {
      photo = await pixelsOf(page.image);
    } catch {
      throw new Error(`Page ${i + 1}: this photo couldn't be read. Take it again.`);
    }
    stopIfAborted(signal);
    const { size, rect } = layout(layoutOpts, shownShape(page, photo, opts.pageSize === "fit"));
    const bw = page.filter === "bw";
    // As many pixels as the page shows at its resolution.
    const flat = flattenPage(photo, page, (Math.max(rect.width, rect.height) / 72) * (bw ? BW_DPI : PHOTO_DPI));
    const pdfPage = out.addPage(size);
    if (bw) {
      // Two colours: stored losslessly at one bit a pixel.
      drawOrientedImage(pdfPage, await embedPixels(out, flat), 1, rect);
    } else {
      const jpeg = await encodeJpeg(flat, { quality: SCAN_QUALITY, gray: page.filter === "gray" });
      drawOrientedImage(pdfPage, await out.embedJpg(jpeg), 1, rect);
    }
  }
  onProgress?.(1, "Saving the PDF…");
  return out.save();
}
