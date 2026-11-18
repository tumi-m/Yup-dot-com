/**
 * Crop PDF's work with pdf.js and a canvas, done in the page (a worker has
 * no pdf.js canvas here): pictures of the areas kept, for "Remove what's
 * outside the box", and the content found on each page for "Trim white
 * margins". Node tests pass node-canvas.
 *
 * One page is drawn at a time and its canvas is let go of at once.
 */
import type { LoadedPdf } from "../render";
import { canvasToJpeg } from "../../jpeg-encode/off-thread";
import { stopIfAborted } from "../../abort";
import { MAX_JPEG_BYTES, MAX_PIXELS, TooManyPixelsError } from "../raster";
import type { CropPicture } from "./index";
import { contentBox, trimMargins, type Margins } from "./geometry";

export interface CanvasOptions {
  /** A fresh canvas; Node tests pass node-canvas. */
  canvas?: () => HTMLCanvasElement;
  progress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

/** A turn for the page between pages, so progress paints and Cancel is heard. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));
const free = (canvas: HTMLCanvasElement) => {
  canvas.width = canvas.height = 0;
};
const canvasMaker = (opts: CanvasOptions) => opts.canvas ?? (() => document.createElement("canvas"));

/** Pictures of the area kept on each page, at `dpi`, with the page's own text inside it when `keepText`. */
export async function pictureAreas(
  loaded: LoadedPdf,
  crops: { page: number; margins: Margins }[],
  opts: CanvasOptions & { dpi: number; keepText: boolean; quality?: number; maxPixels?: number }
): Promise<Record<number, CropPicture>> {
  const scale = opts.dpi / 72;
  const make = canvasMaker(opts);
  const maxPixels = opts.maxPixels ?? MAX_PIXELS;
  // Every picture stays in memory until the file is written: sizes first, before anything is drawn.
  let pixels = 0;
  for (const [k, { page, margins: m }] of crops.entries()) {
    stopIfAborted(opts.signal);
    const vp = await loaded.getPageViewport(page + 1, 1);
    pixels += (vp.width - m.left - m.right) * (vp.height - m.top - m.bottom) * scale * scale;
    if (pixels > maxPixels) throw new TooManyPixelsError((pixels / (k + 1)) * crops.length);
  }
  const out: Record<number, CropPicture> = {};
  let made = 0;
  for (const [k, { page, margins: m }] of crops.entries()) {
    stopIfAborted(opts.signal);
    opts.progress?.(k / crops.length, `Drawing page ${page + 1}…`);
    const vp = await loaded.getPageViewport(page + 1, 1);
    const whole = make();
    const area = make();
    let jpeg: Uint8Array;
    try {
      await loaded.renderPage(page + 1, whole, scale, { pixelRatio: 1, forms: true });
      // A very large page is drawn smaller to fit the browser's canvas limits.
      const r = whole.width / vp.width;
      const width = vp.width - m.left - m.right;
      const height = vp.height - m.top - m.bottom;
      area.width = Math.max(1, Math.round(width * r));
      area.height = Math.max(1, Math.round(height * r));
      const ctx = area.getContext("2d");
      if (!ctx) throw new Error("This browser couldn't draw the page.");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, area.width, area.height);
      ctx.drawImage(whole, m.left * r, m.top * r, width * r, height * r, 0, 0, area.width, area.height);
      free(whole);
      jpeg = await canvasToJpeg(area, opts.quality ?? 0.85);
    } finally {
      free(whole);
      free(area);
    }
    made += jpeg.length;
    if (made > MAX_JPEG_BYTES) throw new TooManyPixelsError(NaN);
    let text: CropPicture["text"] = [];
    if (opts.keepText) {
      const x1 = vp.width - m.right;
      const y1 = vp.height - m.bottom;
      // Only text wholly inside: a line cut by the edge would bring its hidden words along.
      text = (await loaded.ownText(page + 1))
        .filter((p) => p.x0 >= m.left - 0.5 && p.y0 >= m.top - 0.5 && p.x1 <= x1 + 0.5 && p.y1 <= y1 + 0.5)
        .map((p) => ({ ...p, x0: p.x0 - m.left, x1: p.x1 - m.left, y0: p.y0 - m.top, y1: p.y1 - m.top }));
    }
    out[page] = { jpeg, text };
    await loaded.release(page + 1);
    await breathe();
  }
  return out;
}

/** Pages are looked at this many pixels along their longer side: about a point to the pixel on A4. */
const TRIM_PX = 800;

/**
 * The margins that trim each page to its content plus `padding` points, or
 * null for a page with nothing to trim (blank, or content to the edges).
 */
export async function findMargins(
  loaded: LoadedPdf,
  pages: number[],
  opts: CanvasOptions & { padding: number }
): Promise<Map<number, Margins | null>> {
  const make = canvasMaker(opts);
  const out = new Map<number, Margins | null>();
  for (const [k, page] of pages.entries()) {
    stopIfAborted(opts.signal);
    if (k % 5 === 0) opts.progress?.(k / pages.length, `Finding the edges: page ${page + 1}…`);
    out.set(page, await findPageMargins(loaded, page, opts.padding, make));
    await loaded.release(page + 1);
    if (k % 5 === 4) await breathe();
  }
  return out;
}

export async function findPageMargins(
  loaded: LoadedPdf,
  page: number,
  padding: number,
  make: () => HTMLCanvasElement = canvasMaker({})
): Promise<Margins | null> {
  const vp = await loaded.getPageViewport(page + 1, 1);
  const canvas = make();
  try {
    // Fields and notes are content too.
    await loaded.renderPage(page + 1, canvas, Math.min(2, TRIM_PX / Math.max(vp.width, vp.height, 1)), { pixelRatio: 1, forms: true });
    const ctx = canvas.getContext("2d");
    if (!ctx || !canvas.width || !canvas.height) return null;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / vp.width;
    return trimMargins(contentBox(data, canvas.width, canvas.height), scale, vp, padding);
  } finally {
    free(canvas);
  }
}
