"use client";

import { loadForRender } from "./render";
import { canvasToJpeg } from "../image-codec";
import { looksGarbled, newWords, textAgrees, type OcrPage, type OcrText, type OcrWord, type OwnText } from "./ocr-layer";
import tesseractPkg from "tesseract.js/package.json";

/** Engine, WebAssembly core, and language models are all self-hosted. */
const TESSERACT_BASE = `/vendor/tesseract/${tesseractPkg.version}`;
const TESSDATA = "/vendor/tessdata/4.0.0_best_int";

/**
 * Browser-side OCR: renders each page with pdf.js and recognises it with
 * Tesseract (WebAssembly). Nothing leaves the device — the engine and language
 * model are fetched from this site once and cached by the browser.
 */

export { OCR_LANGUAGES } from "./ocr-languages";

export interface OcrProgress {
  page: number;
  total: number;
  /** 0..1 within the current page. */
  pageProgress: number;
  stage: "loading" | "rendering" | "recognizing";
}

const RENDER_SCALE = 2; // ~144 DPI — a good accuracy/speed balance for OCR.

/** Pages with fewer characters than this have no real text layer of their own. */
const HAS_TEXT = 40;

export interface OcrOptions {
  lang?: string;
  onProgress?: (p: OcrProgress) => void;
  /**
   * Only the words the PDF's own text doesn't already have (see newWords): a
   * second copy would turn up twice in search and copy. Pages of plain text
   * aren't read at all once one of them shows the text layer is sound.
   * Null for pages left unread.
   */
  newWordsOnly?: boolean;
  /** Stops the run at once: Cancel, a new file, or leaving the tool. */
  signal?: AbortSignal;
}

const abortError = () => new DOMException("Cancelled.", "AbortError");
const ENGINE_FAILED = "Couldn't load the OCR engine. Check your connection and try again.";

/** Recognised words per page, measured on a render of each page as displayed. */
export async function ocrDocument(bytes: Uint8Array, opts?: OcrOptions & { images?: false }): Promise<(OcrText | null)[]>;
/** The same with each page's render as a JPEG, to rebuild the PDF from (for PDFs that can't be edited). */
export async function ocrDocument(bytes: Uint8Array, opts: OcrOptions & { images: true }): Promise<OcrPage[]>;
export async function ocrDocument(
  bytes: Uint8Array,
  opts: OcrOptions & { images?: boolean } = {}
): Promise<(OcrText | OcrPage | null)[]> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  const { createWorker } = await import("tesseract.js");
  const loaded = await loadForRender(bytes);
  if (signal?.aborted) {
    loaded.destroy();
    throw abortError();
  }
  const total = loaded.numPages;
  const newOnly = !!opts.newWordsOnly && !opts.images;
  // Progress counts the pages actually read.
  let current = 1;
  let count = total;

  opts.onProgress?.({ page: 1, total, pageProgress: 0, stage: "loading" });
  // Tesseract reports a language file that didn't download here, not by rejecting.
  let engineFailed: (err: unknown) => void = () => {};
  const engineError = new Promise<never>((_, reject) => (engineFailed = reject));
  engineError.catch(() => {});
  // The engine loads while the pages are checked.
  const workerReady = createWorker(opts.lang ?? "eng", 1, {
    workerPath: `${TESSERACT_BASE}/worker.min.js`,
    corePath: `${TESSERACT_BASE}/core`,
    langPath: TESSDATA,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") {
        opts.onProgress?.({ page: current, total: count, pageProgress: m.progress, stage: "recognizing" });
      }
    },
    errorHandler: (err: unknown) => engineFailed(err),
  });
  // A failed load is reported where it is awaited, below.
  workerReady.catch(() => {});

  // On abort, the engine and pdf.js stop now rather than after the last page,
  // and whatever the run is waiting on gives way.
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    workerReady.then((w) => w.terminate(), () => {});
    loaded.destroy();
  };
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      stop();
      reject(abortError());
    };
  });
  aborted.catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  // Aborted from the progress callback above.
  if (signal?.aborted) onAbort();
  const until = <T>(work: Promise<T>) => Promise.race([work, aborted]);

  const pages: (OcrText | OcrPage | null)[] = new Array(total).fill(null);
  try {
    let toRead = Array.from({ length: total }, (_, i) => i + 1);
    const own = new Map<number, OwnText[]>();
    // Plain-text pages: no pictures, and a text layer of their own.
    let plain: number[] = [];
    let sample = 0;
    if (newOnly) {
      toRead = [];
      for (let i = 1; i <= total; i++) {
        const pieces = await until(loaded.ownText(i));
        own.set(i, pieces);
        const text = pieces.map((t) => t.text).join(" ");
        const hasText = text.replace(/\s+/g, "").length >= HAS_TEXT && !looksGarbled(text);
        if (hasText && !(await until(loaded.showsPictures(i)))) plain.push(i);
        else toRead.push(i);
      }
      // Read one plain page (the fullest) to check the text layer says what the
      // page shows; the rest are read only if it doesn't.
      sample = plain.reduce((best, i) => (textLength(own.get(i)!) > textLength(own.get(best)!) ? i : best), plain[0] ?? 0);
      if (sample) toRead.unshift(sample);
      plain = plain.filter((i) => i !== sample);
    }
    let worker: Awaited<typeof workerReady>;
    try {
      worker = await until(Promise.race([workerReady, engineError]));
    } catch (err) {
      if (signal?.aborted) throw err;
      // Tesseract rejects with a bare message, which would read "Something went wrong."
      throw new Error(ENGINE_FAILED);
    }

    for (let k = 0; k < toRead.length; k++) {
      if (signal?.aborted) throw abortError();
      const i = toRead[k];
      current = k + 1;
      count = toRead.length;
      opts.onProgress?.({ page: current, total: count, pageProgress: 0, stage: "rendering" });
      const vp = await until(loaded.getPageViewport(i, RENDER_SCALE));
      const canvas = document.createElement("canvas");
      // Word boxes are measured against canvas.width/height below, so any
      // devicePixelRatio applied by renderPage is accounted for automatically.
      await until(loaded.renderPage(i, canvas, RENDER_SCALE));

      const { data } = await until(worker.recognize(canvas, {}, { blocks: true, text: true }));
      const words: OcrWord[] = [];
      for (const block of data.blocks ?? []) {
        for (const para of block.paragraphs) {
          for (const line of para.lines) {
            for (const w of line.words) {
              words.push({ text: w.text, confidence: w.confidence, ...w.bbox });
            }
          }
        }
      }

      const text: OcrText = {
        widthPt: vp.baseWidth,
        heightPt: vp.baseHeight,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        words,
      };
      if (newOnly) {
        const pieces = own.get(i)!;
        // A text layer that doesn't say what the page shows: read every page.
        if (i === sample && !textAgrees(words, pieces.map((t) => t.text).join(" "))) toRead.push(...plain);
        text.words = newWords(text, pieces);
        text.known = words.length - text.words.length;
      }
      pages[i - 1] = opts.images ? { ...text, imageType: "jpeg", image: await canvasToJpeg(canvas, 0.85) } : text;
      canvas.width = canvas.height = 0;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop();
  }
  return pages;
}

const textLength = (pieces: OwnText[]) => pieces.reduce((n, t) => n + t.text.length, 0);

/** Plain text from OCR results, one block per page. */
export function ocrText(pages: (OcrText | null)[]): string {
  return pages
    .map((p, i) => {
      if (!p) return `--- Page ${i + 1} ---\n`;
      // Rebuild lines by grouping words with overlapping vertical extents.
      const sorted = [...p.words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      const lines: OcrWord[][] = [];
      for (const w of sorted) {
        const line = lines.find((l) => {
          const ref = l[0];
          const overlap = Math.min(ref.y1, w.y1) - Math.max(ref.y0, w.y0);
          return overlap > (Math.min(ref.y1 - ref.y0, w.y1 - w.y0) * 0.5);
        });
        if (line) line.push(w);
        else lines.push([w]);
      }
      const text = lines
        .map((l) => l.sort((a, b) => a.x0 - b.x0).map((w) => w.text).join(" "))
        .join("\n");
      return `--- Page ${i + 1} ---\n${text}`;
    })
    .join("\n\n") + "\n";
}
