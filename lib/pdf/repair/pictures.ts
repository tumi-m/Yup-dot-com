/**
 * Pages pdf-lib can't copy, drawn by pdf.js, which reads damaged files far
 * more forgivingly: each becomes a picture of the page as it shows, fields
 * included, with the page's own text laid over it, invisible, so it can
 * still be searched and copied. Needs a canvas: it runs on the page (pdf.js
 * itself reads the file in its own worker).
 */
import { PDFDocument, type PDFFont } from "pdf-lib";
import type { LoadedPdf } from "../render";
import { MAX_JPEG_BYTES, MAX_PIXELS, TooManyPixelsError, addPicturePage, breathe } from "../raster";
import { isAbort, stopIfAborted } from "../../abort";

/** 150 DPI: text stays readable on screen and in print. */
const SCALE = 150 / 72;
/** Never below 72 DPI. */
const MIN_SCALE = 1;

export interface Drawn {
  /** The pictures, one page each, in the order of `made`; null when none could be drawn. */
  bytes: Uint8Array | null;
  /** The pages drawn (1-based in `loaded`), and whether their text could be laid over them. */
  made: { page: number; text: boolean }[];
  /** Pages pdf.js couldn't draw either, or that drew nothing at all. */
  failed: number[];
}

/**
 * Draws `pages` of `loaded` (1-based) as pictures. Many large pages are
 * drawn at a lower resolution, so they fit in a browser tab.
 */
export async function drawPictures(
  loaded: LoadedPdf,
  pages: number[],
  opts: {
    progress?: (fraction: number, label: string) => void;
    signal?: AbortSignal;
    canvas?: () => HTMLCanvasElement;
  } = {}
): Promise<Drawn> {
  const failed: number[] = [];
  const sizes = new Map<number, number>();
  // Page sizes first, which pdf.js reads without drawing.
  for (const page of pages) {
    stopIfAborted(opts.signal);
    try {
      const vp = await loaded.getPageViewport(page, 1);
      sizes.set(page, vp.width * vp.height);
    } catch {
      failed.push(page);
    }
  }
  const area = [...sizes.values()].reduce((a, b) => a + b, 0);
  const scale = Math.min(SCALE, Math.sqrt(MAX_PIXELS / Math.max(area, 1)));
  if (scale < MIN_SCALE) throw new TooManyPixelsError(area * SCALE * SCALE);

  const out = await PDFDocument.create();
  const fonts: { font?: PDFFont } = {};
  const made: Drawn["made"] = [];
  let jpegBytes = 0;
  const todo = pages.filter((p) => sizes.has(p));
  for (let k = 0; k < todo.length; k++) {
    const page = todo[k];
    stopIfAborted(opts.signal);
    opts.progress?.(k / todo.length, todo.length > 1 ? `Drawing page ${k + 1} of ${todo.length}` : "Drawing the page…");
    try {
      // A page whose content is missing draws nothing: it isn't recovered.
      if (!(await loaded.paints(page))) {
        failed.push(page);
        continue;
      }
      const drawn = await addPicturePage(out, loaded, page, { scale, quality: 0.85, keepText: true, canvas: opts.canvas, fonts });
      jpegBytes += drawn.jpegBytes;
      if (jpegBytes > MAX_JPEG_BYTES) throw new TooManyPixelsError(NaN);
      made.push({ page, text: drawn.text });
    } catch (err) {
      if (isAbort(err) || err instanceof TooManyPixelsError) throw err;
      failed.push(page);
    } finally {
      await loaded.release(page).catch(() => {});
    }
    await breathe();
  }
  stopIfAborted(opts.signal);
  const bytes = made.length ? await out.save({ addDefaultPage: false }) : null;
  return { bytes, made, failed: failed.sort((a, b) => a - b) };
}
