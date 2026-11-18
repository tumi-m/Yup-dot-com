/**
 * One comparison from start to finish: both files' text read page by page
 * with pdf.js (in the page: pdf.js parses in its own worker), the word diff
 * in a worker, pages without text (or every page, when asked) drawn and
 * compared by how they look, then the report and marked copies written in
 * a worker. Node tests pass node-canvas.
 */
import { isAbort, stopIfAborted } from "../../abort";
import { friendlyPdfError } from "../errors";
import type { PageText } from "../parse";
import type { LoadedPdf } from "../render";
import type { FontFiles } from "../text-to-pdf/fonts";
import type { Exports } from "./exports";
import { withPictures, type CompareResult, type PictureChange } from "./index";
import { pixelDiff, type PixelArea } from "./pixels";
import { PAGE_TEXT, readWords, type Box, type ReadDocument } from "./words";

export interface CompareSource {
  file: Blob;
  name: string;
  loaded: LoadedPdf;
}

export interface Compared {
  result: CompareResult;
  a: ReadDocument;
  b: ReadDocument;
  exports: Exports;
}

export interface CompareRunOptions {
  /** Compare how every page looks, not only pages without text. */
  looks?: boolean;
  /** A fresh canvas; Node tests pass node-canvas. */
  canvas?: () => HTMLCanvasElement;
  progress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
  /** The report's font files (from /vendor in the browser). */
  fonts?: FontFiles;
  /** The day the report prints. */
  date?: string;
}

/** Pages are drawn this many pixels along their longer side to compare how they look. */
const LOOK_PIXELS = 1100;

/** A turn for the page between pages, so progress paints and Cancel is heard. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every page's text, a page at a time; pdf.js lets go of each page once read. */
async function readDocument(loaded: LoadedPdf, name: string, progress: (f: number, label: string) => void, signal?: AbortSignal): Promise<ReadDocument> {
  const pages: PageText[] = [];
  for (let p = 1; p <= loaded.numPages; p++) {
    stopIfAborted(signal);
    progress((p - 1) / loaded.numPages, `Reading ${name}, page ${p} of ${loaded.numPages}…`);
    let page: PageText;
    try {
      page = await loaded.readText(p);
    } catch (err) {
      throw friendlyPdfError(err, name);
    }
    // Next to no text: a scan if it shows a picture, else a title page or a drawing.
    if (page.chars < PAGE_TEXT) page.pictures = await loaded.showsPictures(p).catch(() => false);
    pages.push(page);
    await loaded.release(p).catch(() => {});
    if (p % 8 === 0) await breathe();
  }
  return readWords(pages);
}

/** A page drawn onto a white sheet of `width` × `height` pixels, as RGBA. */
async function drawn(loaded: LoadedPdf, page: number, scale: number, width: number, height: number, make: () => HTMLCanvasElement) {
  const one = make();
  const sheet = make();
  try {
    await loaded.renderPage(page + 1, one, scale, { pixelRatio: 1, forms: true });
    sheet.width = width;
    sheet.height = height;
    const ctx = sheet.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(one, 0, 0);
    return ctx.getImageData(0, 0, width, height).data;
  } finally {
    one.width = one.height = 0;
    sheet.width = sheet.height = 0;
    await loaded.release(page + 1).catch(() => {});
  }
}

const overlaps = (p: PixelArea, b: Box) => p.x < b.x + b.width && b.x < p.x + p.width && p.y < b.y + b.height && b.y < p.y + p.height;

/**
 * Page pairs that look different outside their words: the text diff already
 * tells of words, and a word put in moves the rest of its paragraph, which
 * would look like a change everywhere.
 */
async function comparePictures(
  a: CompareSource,
  b: CompareSource,
  docA: ReadDocument,
  docB: ReadDocument,
  result: CompareResult,
  opts: CompareRunOptions,
  progress: (f: number, label: string) => void
): Promise<PictureChange[]> {
  const make = opts.canvas ?? (() => document.createElement("canvas"));
  const scannedA = new Set(result.scanned.a);
  const scannedB = new Set(result.scanned.b);
  const todo = result.pairs.flatMap((p, n) =>
    p.a !== null && p.b !== null && (opts.looks || scannedA.has(p.a) || scannedB.has(p.b)) ? [{ n, a: p.a, b: p.b }] : []
  );
  const out: PictureChange[] = [];
  for (const [k, t] of todo.entries()) {
    stopIfAborted(opts.signal);
    progress(k / todo.length, `Comparing how page ${t.b + 1} looks…`);
    const pa = docA.pages[t.a];
    const pb = docB.pages[t.b];
    const scale = Math.min(1.5, LOOK_PIXELS / Math.max(pa.width, pa.height, pb.width, pb.height));
    const width = Math.max(1, Math.ceil(Math.max(pa.width, pb.width) * scale));
    const height = Math.max(1, Math.ceil(Math.max(pa.height, pb.height) * scale));
    let pixelsA: Uint8ClampedArray;
    let pixelsB: Uint8ClampedArray;
    try {
      pixelsA = await drawn(a.loaded, t.a, scale, width, height, make);
      pixelsB = await drawn(b.loaded, t.b, scale, width, height, make);
    } catch (err) {
      if (isAbort(err)) throw err;
      // A page that can't be drawn here is left to the text comparison.
      continue;
    }
    const words = [...docA.words.slice(pa.from, pa.to), ...docB.words.slice(pb.from, pb.to)].flatMap((w) => w.boxes);
    const areas = pixelDiff(pixelsA, pixelsB, width, height)
      .areas.map((p) => ({ x: p.x / scale, y: p.y / scale, width: p.width / scale, height: p.height / scale }))
      .filter((p) => !words.some((box) => overlaps(p, box)));
    if (areas.length) out.push({ pair: t.n, areas: { a: areas, b: areas } });
    await breathe();
  }
  return out;
}

export async function compareDocuments(a: CompareSource, b: CompareSource, opts: CompareRunOptions = {}): Promise<Compared> {
  const { signal } = opts;
  // Rough shares of the time each stage takes.
  const looks = opts.looks ? 4 : 1;
  const stages = [2, 2, 1, looks, 2];
  const total = stages.reduce((x, y) => x + y, 0);
  const stage = (i: number) => {
    const from = stages.slice(0, i).reduce((x, y) => x + y, 0) / total;
    return (fraction: number, label: string) => opts.progress?.(from + (stages[i] / total) * Math.max(0, Math.min(1, fraction)), label);
  };
  try {
    const docA = await readDocument(a.loaded, a.name, stage(0), signal);
    const docB = await readDocument(b.loaded, b.name, stage(1), signal);
    stage(2)(0, "Comparing the words…");
    const { diffOffThread, exportsOffThread } = await import("./off-thread");
    let result = await diffOffThread(docA, docB, signal);
    const pictures = await comparePictures(a, b, docA, docB, result, opts, stage(3));
    result = withPictures(result, pictures, docA, docB);
    const date = opts.date ?? new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const exports = await exportsOffThread(
      { a: { file: a.file, name: a.name, doc: docA }, b: { file: b.file, name: b.name, doc: docB }, result, date },
      stage(4),
      signal,
      ...(opts.fonts ? [opts.fonts] : [])
    );
    return { result, a: docA, b: docB, exports };
  } catch (err) {
    if (isAbort(err)) throw err;
    throw friendlyPdfError(err);
  }
}
