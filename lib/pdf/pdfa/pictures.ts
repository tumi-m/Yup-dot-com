/**
 * Pages that can't be made PDF/A in place, drawn by pdf.js as pictures with
 * their own text laid over them, invisible, so they can still be searched
 * and copied (raster.ts). Needs a canvas: it runs on the page.
 */
import { PDFDocument, type PDFFont } from "pdf-lib";
import { loadForRender } from "../render";
import { MAX_JPEG_BYTES, MAX_PIXELS, TooManyPixelsError, addPicturePage, breathe } from "../raster";
import { stopIfAborted } from "../../abort";

/** 200 DPI: sharp in print, a fair size on disk. */
const SCALE = 200 / 72;
/** Never below 100 DPI. */
const MIN_SCALE = 100 / 72;

export const TOO_MANY = "Too many pages here would have to become pictures to fit in this browser tab. Split the PDF first.";

/** Draws `pages` (0-based) of `bytes`, in order, into one PDF of pictures. */
export async function drawPages(
  bytes: Uint8Array,
  pages: number[],
  opts: { progress?: (fraction: number, label: string) => void; signal?: AbortSignal; canvas?: () => HTMLCanvasElement } = {}
): Promise<Uint8Array> {
  const loaded = await loadForRender(bytes);
  try {
    let area = 0;
    for (const p of pages) {
      const vp = await loaded.getPageViewport(p + 1, 1);
      area += vp.width * vp.height;
    }
    const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / Math.max(area, 1)));
    if (scale < MIN_SCALE) throw new TooManyPixelsError(area * SCALE * SCALE);
    const out = await PDFDocument.create();
    const fonts: { font?: PDFFont } = {};
    let jpegBytes = 0;
    for (let k = 0; k < pages.length; k++) {
      stopIfAborted(opts.signal);
      opts.progress?.(k / pages.length, pages.length > 1 ? `Drawing page ${pages[k] + 1} (${k + 1} of ${pages.length})…` : `Drawing page ${pages[k] + 1}…`);
      const drawn = await addPicturePage(out, loaded, pages[k] + 1, { scale, quality: 0.85, keepText: true, canvas: opts.canvas, fonts });
      jpegBytes += drawn.jpegBytes;
      if (jpegBytes > MAX_JPEG_BYTES) throw new TooManyPixelsError(NaN);
      await loaded.release(pages[k] + 1).catch(() => {});
      await breathe();
    }
    return await out.save({ addDefaultPage: false });
  } finally {
    loaded.destroy();
  }
}
