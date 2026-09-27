"use client";

import { loadForRender } from "./render";
import type { OcrPage, OcrWord } from "./ocr-layer";
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

async function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85)
  );
  if (!blob) throw new Error("Could not encode page image.");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function ocrDocument(
  bytes: Uint8Array,
  opts: { lang?: string; onProgress?: (p: OcrProgress) => void } = {}
): Promise<OcrPage[]> {
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

  const pages: OcrPage[] = [];
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

      pages.push({
        widthPt: vp.baseWidth,
        heightPt: vp.baseHeight,
        image: await canvasToBytes(canvas),
        imageType: "jpeg",
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        words,
      });
    }
  } finally {
    await worker.terminate();
    loaded.destroy();
  }
  return pages;
}

/** Plain text from OCR results, one block per page. */
export function ocrText(pages: OcrPage[]): string {
  return pages
    .map((p, i) => {
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
