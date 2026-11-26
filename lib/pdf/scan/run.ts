/**
 * Scan to PDF from start to finish: the pages built (in a worker), then,
 * when asked, read with the OCR PDF tool's engine and given an invisible
 * text layer, so the scan can be searched and copied. All on the device.
 */
import { PDFDocument } from "pdf-lib";
import type { OcrText } from "../ocr-layer";
import type { ScanOptions, ScanPage } from "./build";

export interface ScanRun extends ScanOptions {
  /** A language code from OCR_LANGUAGES, or null for no text layer. */
  ocr: string | null;
}

export interface ScanResult {
  bytes: Uint8Array;
  pages: number;
  /** Words given a text layer; null when OCR wasn't asked for. */
  words: number | null;
}

type Progress = (fraction: number, label: string) => void;

/** How the pages are read: the OCR PDF tool's engine (tests pass their own). */
export type Reader = (bytes: Uint8Array, lang: string, progress: Progress, signal?: AbortSignal) => Promise<(OcrText | null)[]>;

const readPages: Reader = async (bytes, lang, progress, signal) => {
  const { ocrDocument } = await import("../ocr");
  return ocrDocument(bytes, {
    lang,
    signal,
    onProgress: (p) => progress((p.page - 1 + p.pageProgress) / p.total, p.stage === "loading" ? "Loading the OCR engine…" : `Reading page ${p.page} of ${p.total}…`),
  });
};

/** "scan-2026-11-18.pdf", from the device's own date. */
export function scanName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `scan-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.pdf`;
}

export async function scanToPdf(
  pages: ScanPage[],
  run: ScanRun,
  ctx: { progress?: Progress; signal?: AbortSignal } = {},
  read: Reader = readPages
): Promise<ScanResult> {
  const { scanPagesToPdf } = await import("./off-thread");
  // Reading text takes far longer than building the pages.
  const share = run.ocr ? 0.3 : 1;
  const bytes = await scanPagesToPdf(pages, { pageSize: run.pageSize }, (f, label) => ctx.progress?.(f * share, label), ctx.signal);
  if (!run.ocr) return { bytes, pages: pages.length, words: null };
  const found = await read(bytes, run.ocr, (f, label) => ctx.progress?.(share + f * (1 - share), label), ctx.signal);
  const words = found.reduce((n, p) => n + (p?.words.length ?? 0), 0);
  // Nothing legible: the scan as it is.
  if (!words) return { bytes, pages: pages.length, words: 0 };
  ctx.progress?.(1, "Adding the text…");
  const { addTextLayer } = await import("../ocr-layer");
  return { bytes: await addTextLayer(await PDFDocument.load(bytes), found), pages: pages.length, words };
}
