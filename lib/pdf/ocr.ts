"use client";

import { loadForRender } from "./render";
import { canvasToJpeg } from "../image-codec";
import { textAgrees, type OcrPage, type OcrText, type OcrWord } from "./ocr-layer";
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
   * Null for pages whose own text already says what OCR reads: a second copy
   * would turn up twice in search and copy. Pages whose text is garbled
   * (broken font encodings) still get the OCR'd words.
   */
  skipPagesWithText?: boolean;
}

/** Recognised words per page, measured on a render of each page as displayed. */
export async function ocrDocument(bytes: Uint8Array, opts?: OcrOptions & { images?: false }): Promise<(OcrText | null)[]>;
/** The same with each page's render as a JPEG, to rebuild the PDF from (for PDFs that can't be edited). */
export async function ocrDocument(bytes: Uint8Array, opts: OcrOptions & { images: true }): Promise<OcrPage[]>;
export async function ocrDocument(
  bytes: Uint8Array,
  opts: OcrOptions & { images?: boolean } = {}
): Promise<(OcrText | OcrPage | null)[]> {
  const { createWorker } = await import("tesseract.js");
  const loaded = await loadForRender(bytes);
  const total = loaded.numPages;
  let current = 1;

  opts.onProgress?.({ page: 1, total, pageProgress: 0, stage: "loading" });
  const worker = await createWorker(opts.lang ?? "eng", 1, {
    workerPath: `${TESSERACT_BASE}/worker.min.js`,
    corePath: `${TESSERACT_BASE}/core`,
    langPath: TESSDATA,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") {
        opts.onProgress?.({ page: current, total, pageProgress: m.progress, stage: "recognizing" });
      }
    },
  });

  const pages: (OcrText | OcrPage | null)[] = [];
  try {
    for (let i = 1; i <= total; i++) {
      current = i;
      opts.onProgress?.({ page: i, total, pageProgress: 0, stage: "rendering" });
      const vp = await loaded.getPageViewport(i, RENDER_SCALE);
      const canvas = document.createElement("canvas");
      // Word boxes are measured against canvas.width/height below, so any
      // devicePixelRatio applied by renderPage is accounted for automatically.
      await loaded.renderPage(i, canvas, RENDER_SCALE);

      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
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

      if (opts.skipPagesWithText && !opts.images) {
        const own = await loaded.pageText(i);
        if (own.replace(/\s+/g, "").length >= HAS_TEXT && textAgrees(words, own)) {
          canvas.width = canvas.height = 0;
          pages.push(null);
          continue;
        }
      }

      const text: OcrText = {
        widthPt: vp.baseWidth,
        heightPt: vp.baseHeight,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        words,
      };
      pages.push(opts.images ? { ...text, imageType: "jpeg", image: await canvasToJpeg(canvas, 0.85) } : text);
      canvas.width = canvas.height = 0;
    }
  } finally {
    await worker.terminate();
    loaded.destroy();
  }
  return pages;
}

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
