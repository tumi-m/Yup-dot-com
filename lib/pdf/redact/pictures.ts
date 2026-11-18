/**
 * Redact PDF's work with pdf.js and a canvas, done in the page (a worker
 * has no pdf.js canvas here): a picture of each marked page with the marks
 * painted black before it is encoded, and the words clear of every mark to
 * keep searchable. Node tests pass node-canvas.
 *
 * One page is drawn at a time and its canvas is let go of at once.
 */
import type { LoadedPdf } from "../render";
import { canvasToJpeg } from "../../jpeg-encode/off-thread";
import { stopIfAborted } from "../../abort";
import { MAX_JPEG_BYTES, MAX_PIXELS, TooManyPixelsError, breathe } from "../raster";
import type { CanvasOptions } from "../crop/pictures";
import type { RedactJob } from "./index";
import { countIn, squeezedIn, wordsClear, type Needle, type Rect } from "./marks";

const free = (canvas: HTMLCanvasElement) => {
  canvas.width = canvas.height = 0;
};

/** Paints `rects` (displayed points) black on a canvas drawn `r` pixels to the point, a pixel wider all round. */
export function paintBoxes(ctx: CanvasRenderingContext2D, rects: Rect[], r: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  for (const m of rects) {
    const x0 = Math.floor(m.x0 * r) - 1;
    const y0 = Math.floor(m.y0 * r) - 1;
    ctx.fillRect(x0, y0, Math.ceil(m.x1 * r) + 1 - x0, Math.ceil(m.y1 * r) + 1 - y0);
  }
  ctx.restore();
}

export async function redactPictures(
  loaded: LoadedPdf,
  pages: { page: number; rects: Rect[] }[],
  opts: CanvasOptions & { dpi: number; keepText: boolean; needles: Needle[]; quality?: number; maxPixels?: number }
): Promise<RedactJob["pages"]> {
  const scale = opts.dpi / 72;
  const make = opts.canvas ?? (() => document.createElement("canvas"));
  const maxPixels = opts.maxPixels ?? MAX_PIXELS;
  // Every picture stays in memory until the file is written: sizes first, before anything is drawn.
  let pixels = 0;
  for (const [k, { page }] of pages.entries()) {
    stopIfAborted(opts.signal);
    const vp = await loaded.getPageViewport(page + 1, scale);
    pixels += vp.width * vp.height;
    if (pixels > maxPixels) throw new TooManyPixelsError((pixels / (k + 1)) * pages.length);
  }
  const out: RedactJob["pages"] = [];
  let made = 0;
  for (const [k, { page, rects }] of pages.entries()) {
    stopIfAborted(opts.signal);
    opts.progress?.(k / pages.length, `Drawing page ${page + 1}…`);
    const vp = await loaded.getPageViewport(page + 1, 1);
    const canvas = make();
    let jpeg: Uint8Array;
    try {
      // Comments and fields too: they go from the page, so the picture keeps how they looked.
      await loaded.renderPage(page + 1, canvas, scale, { pixelRatio: 1, forms: true });
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser couldn't draw the page.");
      // A very large page is drawn smaller to fit the browser's canvas limits.
      paintBoxes(ctx, rects, canvas.width / vp.width);
      jpeg = await canvasToJpeg(canvas, opts.quality ?? 0.85);
    } finally {
      free(canvas);
    }
    made += jpeg.length;
    if (made > MAX_JPEG_BYTES) throw new TooManyPixelsError(NaN);
    let words: RedactJob["pages"][number]["picture"]["words"] = [];
    if (opts.keepText) {
      // Words clear of every mark, and not a copy of what a mark took away unless that copy was left on purpose.
      const taken = opts.needles.filter((n) => !(n.allowed[page] > 0));
      words = wordsClear(await loaded.pageText(page + 1), rects)
        .filter((w) => !taken.some((n) => countIn(w.text, n) > 0 || squeezedIn(w.text, n)))
        .map((w) => ({ text: w.text, ...w.rect }));
    }
    out.push({ page, rects, picture: { jpeg, words } });
    await loaded.release(page + 1);
    await breathe();
  }
  return out;
}
