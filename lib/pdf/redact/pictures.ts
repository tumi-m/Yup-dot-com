/**
 * Redact PDF's work with pdf.js and a canvas, done in the page (a worker
 * has no pdf.js canvas here): a picture of each marked page with the marks
 * painted black before it is encoded, and the words clear of every mark to
 * keep searchable. Node tests pass node-canvas.
 *
 * One page is drawn at a time and its canvas is let go of at once.
 *
 * A mark found in the text is placed from the font's widths, or estimated;
 * either can stop short of a letter's ink (a slanted letter, tight kerning,
 * a font measured wrong). So before painting, each such mark grows along
 * its line over any ink it cuts through, up to an em each way, until a
 * clear gap: no part of a letter it touches is left showing.
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

/** How different from the background a pixel must be to count as ink (0 to 255 per channel). */
const INK = 48;

/**
 * `rect` (displayed points, on a canvas drawn `r` pixels to the point)
 * grown along its line over the ink it cuts: each end moves out while the
 * pixels just outside it hold ink, by an em at most. Lines that run the
 * whole way (an underline, a table's border) don't count as ink.
 */
export function growToInk(ctx: CanvasRenderingContext2D, rect: Rect, r: number): Rect {
  const across = rect.x1 - rect.x0 >= rect.y1 - rect.y0;
  // Text marks are 1.25 em tall (or wide, down the page), with a little padding.
  const em = ((across ? rect.y1 - rect.y0 : rect.x1 - rect.x0) / 1.3) * r;
  const { width: W, height: H } = ctx.canvas;
  const px = { x0: Math.floor(rect.x0 * r), y0: Math.floor(rect.y0 * r), x1: Math.ceil(rect.x1 * r), y1: Math.ceil(rect.y1 * r) };
  // The band the mark could grow into: along the line, an em each way.
  const band = across
    ? { x0: Math.max(0, Math.floor(px.x0 - em)), x1: Math.min(W, Math.ceil(px.x1 + em)), y0: Math.max(0, px.y0), y1: Math.min(H, px.y1) }
    : { x0: Math.max(0, px.x0), x1: Math.min(W, px.x1), y0: Math.max(0, Math.floor(px.y0 - em)), y1: Math.min(H, Math.ceil(px.y1 + em)) };
  const bw = band.x1 - band.x0;
  const bh = band.y1 - band.y0;
  if (bw < 2 || bh < 2 || !Number.isFinite(em) || em <= 0) return rect;
  const { data } = ctx.getImageData(band.x0, band.y0, bw, bh);
  // The background: the commonest colour along the band's two long edges, above the letters and below them.
  const counts = new Map<number, number>();
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const edge = across ? y < 2 || y >= bh - 2 : x < 2 || x >= bw - 2;
      if (!edge) continue;
      const p = (y * bw + x) * 4;
      const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let bg = 0;
  let most = -1;
  let edges = 0;
  for (const [k, n] of counts) {
    edges += n;
    if (n > most) [bg, most] = [k, n];
  }
  // No one colour behind the letters (a photo, a pattern): what is ink can't be told.
  if (most < edges * 0.6) return rect;
  const [br, bgG, bb] = [((bg >> 8) & 15) * 16 + 8, ((bg >> 4) & 15) * 16 + 8, (bg & 15) * 16 + 8];
  const ink = (x: number, y: number) => {
    const p = (y * bw + x) * 4;
    return Math.abs(data[p] - br) > INK || Math.abs(data[p + 1] - bgG) > INK || Math.abs(data[p + 2] - bb) > INK;
  };
  // Rules: lines of the band that are ink nearly all the way along.
  const lines = across ? bh : bw;
  const length = across ? bw : bh;
  const rule: boolean[] = [];
  for (let l = 0; l < lines; l++) {
    let n = 0;
    for (let a = 0; a < length; a++) if (across ? ink(a, l) : ink(l, a)) n++;
    rule.push(n > length * 0.9);
  }
  /** A slice across the line, at `a` along it, holds ink. */
  const inked = (a: number) => {
    for (let l = 0; l < lines; l++) if (!rule[l] && (across ? ink(a, l) : ink(l, a))) return true;
    return false;
  };
  const [lo, hi] = across ? [px.x0 - band.x0, px.x1 - band.x0] : [px.y0 - band.y0, px.y1 - band.y0];
  let start = lo;
  while (start - 1 >= 0 && inked(start - 1)) start--;
  let end = hi;
  while (end < length && inked(end)) end++;
  const from = (start + (across ? band.x0 : band.y0)) / r;
  const to = (end + (across ? band.x0 : band.y0)) / r;
  return across ? { ...rect, x0: Math.min(rect.x0, from), x1: Math.max(rect.x1, to) } : { ...rect, y0: Math.min(rect.y0, from), y1: Math.max(rect.y1, to) };
}

export async function redactPictures(
  loaded: LoadedPdf,
  /** `fit`: those of `rects` found in the text, grown over the ink they cut before they are painted. */
  pages: { page: number; rects: Rect[]; fit?: Rect[] }[],
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
  for (const [k, { page, rects: wanted, fit = [] }] of pages.entries()) {
    stopIfAborted(opts.signal);
    opts.progress?.(k / pages.length, `Drawing page ${page + 1}…`);
    const vp = await loaded.getPageViewport(page + 1, 1);
    const canvas = make();
    let jpeg: Uint8Array;
    let rects = wanted;
    try {
      // Comments and fields too: they go from the page, so the picture keeps how they looked.
      await loaded.renderPage(page + 1, canvas, scale, { pixelRatio: 1, forms: true });
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser couldn't draw the page.");
      // A very large page is drawn smaller to fit the browser's canvas limits.
      const r = canvas.width / vp.width;
      // Grown on the page as drawn, before anything is painted on it.
      if (fit.length) rects = wanted.map((m) => (fit.includes(m) ? growToInk(ctx, m, r) : m));
      paintBoxes(ctx, rects, r);
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
