import { PDFDocument, rgb, degrees, StandardFonts } from "pdf-lib";
import { loadForRender } from "./render";
import {
  parseDocument,
  toMarkdown,
  toPlainText,
  toChunks,
  extractTables,
  tableToCsv,
} from "./parse";
import { ENCRYPTED_MESSAGE, NO_TABLES_MESSAGE, SCANNED_MESSAGE, friendlyPdfError } from "./errors";
import { pageFrame } from "./page-frame";
import { openPdf } from "./open";
import { extractorFor, mergeDocuments } from "./operations";
import { isAbort, stopIfAborted } from "../abort";
import { canvasToJpeg } from "../jpeg-encode/off-thread";
import type { OcrProgress } from "./ocr";

/** A processed result ready to hand to the browser for download. */
export interface ToolFile {
  blob: Blob;
  filename: string;
}

function hexToRgb(hex: string) {
  const c = hex.replace("#", "");
  return rgb(
    parseInt(c.slice(0, 2), 16) / 255,
    parseInt(c.slice(2, 4), 16) / 255,
    parseInt(c.slice(4, 6), 16) / 255
  );
}

function pdfBlob(bytes: Uint8Array): Blob {
  // No copy: the bytes are the tool's own, and a merge can be hundreds of MB.
  return new Blob([bytes as unknown as BlobPart], {
    type: "application/pdf",
  });
}

async function canvasBytes(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error("This page is too large to render on this device.");
  return new Uint8Array(await blob.arrayBuffer());
}

/** "report.pdf" → "report-rotated.pdf", so results don't all share one name. */
function suffixed(file: File, suffix: string): string {
  return `${file.name.replace(/\.pdf$/i, "") || "document"}-${suffix}.pdf`;
}

async function buf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

const RANGE = /^(\d+)\s*[-–]\s*(\d*)$/;

/**
 * "1-3, 5; 8 9" → ["1-3", "5", "8", "9"]. Commas, semicolons and spaces all
 * separate parts, except spaces next to a dash ("1 - 3" stays one range).
 */
function rangeParts(input: string): string[] {
  return input
    .split(/[,;]|(?<![\s\-–])\s+(?![\s\-–])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Why `input` can't be split as typed, or null when every part is fine.
 * parseRanges quietly drops what it can't use; this says so instead.
 */
export function rangeProblem(input: string, pageCount: number): string | null {
  const notIn = (n: number) => `Page ${n} isn't in this PDF (${pageCount} page${pageCount === 1 ? "" : "s"}).`;
  for (const part of rangeParts(input)) {
    const m = part.match(RANGE);
    if (m) {
      const a = parseInt(m[1], 10);
      // An open range ("4-") starts at its number; a closed one at its lower end.
      const lo = m[2] ? Math.min(a, parseInt(m[2], 10)) : a;
      const hi = m[2] ? Math.max(a, parseInt(m[2], 10)) : a;
      // A range that starts inside the document is cut at its end ("2-10" → 2-5).
      if (lo > pageCount || hi < 1) return notIn(lo);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n < 1 || n > pageCount) return notIn(n);
    } else {
      return "Use commas between ranges, like 1-3, 5.";
    }
  }
  return null;
}

/**
 * Parse "1-3, 5, 8-10" into a list of 0-indexed page arrays (one per range).
 * Reversed ranges ("5-3") are read as 3-5, open ones ("4-") run to the end,
 * and pages beyond the document are dropped.
 */
export function parseRanges(input: string, pageCount: number): number[][] {
  const ranges: number[][] = [];
  for (const trimmed of rangeParts(input)) {
    const m = trimmed.match(RANGE);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : pageCount;
      const start = Math.max(1, Math.min(a, b));
      const end = Math.min(pageCount, Math.max(a, b));
      const pages: number[] = [];
      for (let i = start; i <= end; i++) pages.push(i - 1);
      if (pages.length) ranges.push(pages);
    } else if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      if (n >= 1 && n <= pageCount) ranges.push([n - 1]);
    }
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------
export async function mergeTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const n = files.length;
  /** Opened one at a time as the merge reaches it, so only one source is held at once. */
  const open = async (file: File) => {
    try {
      const doc = await openPdf(await buf(file));
      // A header with no document after it opens, then fails on the first
      // page lookup: fail here, where the file can be named.
      doc.getPageCount();
      return doc;
    } catch (err) {
      throw friendlyPdfError(err, file.name);
    }
  };
  async function* rest() {
    for (let i = 1; i < n; i++) {
      stopIfAborted(ctx.signal);
      ctx.progress?.(i / n, `File ${i + 1} of ${n}`);
      yield await open(files[i]);
    }
  }
  ctx.progress?.(0, `File 1 of ${n}`);
  // Built on the first file, so its form, title and bookmarks stay.
  return { blob: pdfBlob(await mergeDocuments(await open(files[0]), rest())), filename: "merged.pdf" };
}

function pageLabel(pages: number[]): string {
  const first = pages[0] + 1;
  const last = pages[pages.length - 1] + 1;
  return first === last ? `page-${first}` : `pages-${first}-${last}`;
}

// ---------------------------------------------------------------------------
// Split — one PDF per range (or every page), zipped if more than one
// ---------------------------------------------------------------------------
export async function splitTool(
  files: File[],
  opts: { mode: string; ranges: string },
  ctx: ToolContext = {}
): Promise<ToolFile | ToolFile[]> {
  // Read once: every part is copied out of the same document.
  const src = await openPdf(await buf(files[0]));
  const count = src.getPageCount();
  const base = files[0].name.replace(/\.pdf$/i, "");

  let groups: number[][];
  if (opts.mode === "every") {
    groups = Array.from({ length: count }, (_, i) => [i]);
  } else if (opts.mode === "one") {
    // The chosen pages together, in the order typed, each once.
    const problem = rangeProblem(opts.ranges ?? "", count);
    if (problem) throw new Error(problem);
    const pages = [...new Set(parseRanges(opts.ranges ?? "", count).flat())];
    if (!pages.length) throw new Error(count === 1 ? "This PDF has only 1 page." : `Pick pages between 1 and ${count}.`);
    stopIfAborted(ctx.signal);
    return { blob: pdfBlob(await extractorFor(src)(pages)), filename: `${base}-selected.pdf` };
  } else {
    const problem = rangeProblem(opts.ranges ?? "", count);
    if (problem) throw new Error(problem);
    groups = parseRanges(opts.ranges ?? "", count);
    // Never hand back the whole document as if it were the requested split.
    if (!groups.length) {
      throw new Error(count === 1 ? "This PDF has only 1 page." : `Pick pages between 1 and ${count}.`);
    }
  }

  const extract = extractorFor(src);
  const results: ToolFile[] = [];
  const used = new Map<string, number>();
  for (let g = 0; g < groups.length; g++) {
    stopIfAborted(ctx.signal);
    if (groups.length > 1) ctx.progress?.(g / groups.length, `File ${g + 1} of ${groups.length}`);
    // The document keeps its form, title, bookmarks, links and tags for the
    // pages that stay; the other pages and what only they use are left out,
    // and so are its attachments and scripts.
    const out = await extract(groups[g]);
    // Repeated ranges ("1, 1") must not overwrite each other in the zip.
    const label = pageLabel(groups[g]);
    const n = (used.get(label) ?? 0) + 1;
    used.set(label, n);
    results.push({
      blob: pdfBlob(out),
      filename: `${base}-${label}${n > 1 ? `-${n}` : ""}.pdf`,
    });
  }
  return results.length === 1 ? results[0] : results;
}

// ---------------------------------------------------------------------------
// Compress — images are resized to what the page shows and re-encoded; text,
// links, bookmarks and forms stay as they are (see lib/pdf/compress).
// ---------------------------------------------------------------------------
export async function compressTool(
  files: File[],
  opts: { quality: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  const file = files[0];
  const [{ presetFrom }, { compressFile }] = await Promise.all([import("./compress"), import("./compress/off-thread")]);
  const preset = presetFrom(opts.quality);
  let compressed: Uint8Array;
  try {
    compressed = await compressFile(file, preset, ctx.progress, ctx.signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    if (friendlyPdfError(err).message === ENCRYPTED_MESSAGE) throw friendlyPdfError(err);
    // A file pdf-lib can't read: pdf.js may still render it.
    try {
      compressed = await rasterCompress(await buf(file), { smallest: 0.4, balanced: 0.6, high: 0.8 }[preset], ctx);
    } catch (fallbackErr) {
      throw friendlyPdfError(fallbackErr);
    }
  }
  // Never hand back a bigger file, nor one that is barely smaller.
  if (compressed.length > file.size * 0.98) {
    return { blob: new Blob([file], { type: "application/pdf" }), filename: file.name.replace(/\.pdf$/i, "") + ".pdf" };
  }
  return { blob: pdfBlob(compressed), filename: suffixed(file, "compressed") };
}

/** Last resort for damaged files: each page becomes a JPEG (text is no longer selectable). */
async function rasterCompress(bytes: Uint8Array, quality: number, ctx: ToolContext): Promise<Uint8Array> {
  const { canvasToJpeg } = await import("../jpeg-encode/off-thread");
  const loaded = await loadForRender(bytes);
  const out = await PDFDocument.create();
  const scale = 1.5; // ~108 DPI
  try {
    for (let i = 1; i <= loaded.numPages; i++) {
      stopIfAborted(ctx.signal);
      ctx.progress?.((i - 1) / loaded.numPages, `Page ${i} of ${loaded.numPages}`);
      const vp = await loaded.getPageViewport(i, scale);
      const canvas = document.createElement("canvas");
      await loaded.renderPage(i, canvas, scale, { pixelRatio: 1 });
      const img = await out.embedJpg(await canvasToJpeg(canvas, quality));
      canvas.width = canvas.height = 0; // release the bitmap now, not at GC time
      const page = out.addPage([vp.baseWidth, vp.baseHeight]);
      page.drawImage(img, { x: 0, y: 0, width: vp.baseWidth, height: vp.baseHeight });
    }
  } finally {
    loaded.destroy();
  }
  return out.save();
}

// ---------------------------------------------------------------------------
// PDF -> images
// ---------------------------------------------------------------------------
export async function pdfToImagesTool(
  files: File[],
  opts: { format: string; quality: string },
  ctx: ToolContext = {}
): Promise<ToolFile[]> {
  const format = opts.format === "png" ? "png" : "jpeg";
  const quality = Number(opts.quality) || 0.92;
  const bytes = await buf(files[0]);
  const loaded = await loadForRender(bytes);
  const base = files[0].name.replace(/\.pdf$/i, "");
  const results: ToolFile[] = [];
  // Zero-pad to the page count so files sort in page order (…-099, …-100).
  const digits = Math.max(2, String(loaded.numPages).length);

  try {
    for (let i = 1; i <= loaded.numPages; i++) {
      stopIfAborted(ctx.signal);
      ctx.progress?.((i - 1) / loaded.numPages, `Page ${i} of ${loaded.numPages}`);
      const canvas = document.createElement("canvas");
      await loaded.renderPage(i, canvas, 2, { pixelRatio: 1 });
      // JPEGs through MozJPEG; progressive, since every image viewer reads it and it is smaller.
      const bytes = format === "jpeg" ? await canvasToJpeg(canvas, quality, { progressive: true }) : await canvasBytes(canvas, "image/png");
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: `image/${format}` });
      canvas.width = canvas.height = 0;
      results.push({
        blob,
        filename: `${base}-page-${String(i).padStart(digits, "0")}.${format === "jpeg" ? "jpg" : "png"}`,
      });
    }
  } finally {
    loaded.destroy();
  }
  return results;
}

// ---------------------------------------------------------------------------
// Images -> PDF
// ---------------------------------------------------------------------------
export async function imagesToPdfTool(
  files: File[],
  opts: { pageSize: string; margin: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  // Decoding, resizing and encoding phone photos takes seconds each: it runs in a worker.
  const { imagesToPdfFile } = await import("./images-to-pdf/off-thread");
  return { blob: pdfBlob(await imagesToPdfFile(files, opts, ctx.progress, ctx.signal)), filename: "images.pdf" };
}

// ---------------------------------------------------------------------------
// Rotate
// ---------------------------------------------------------------------------
export async function rotateTool(
  files: File[],
  opts: { angle: string; pages?: string; which?: string }
): Promise<ToolFile> {
  const delta = Number(opts.angle) || 90;
  const doc = await openPdf(await buf(files[0]));
  const count = doc.getPageCount();
  let chosen: Set<number> | null = null;
  if (opts.pages === "some") {
    const which = opts.which ?? "";
    const problem = which.trim() ? rangeProblem(which, count) : null;
    if (problem) throw new Error(problem);
    chosen = new Set(parseRanges(which, count).flat());
    if (!chosen.size) throw new Error(`Pick pages between 1 and ${count}.`);
  }
  doc.getPages().forEach((page, i) => {
    if (chosen && !chosen.has(i)) return;
    const current = page.getRotation().angle;
    page.setRotation(degrees((current + delta + 360) % 360));
  });
  return { blob: pdfBlob(await doc.save()), filename: suffixed(files[0], "rotated") };
}

// ---------------------------------------------------------------------------
// Page numbers
// ---------------------------------------------------------------------------
export async function pageNumbersTool(
  files: File[],
  opts: { position: string; format: string; fontSize: string }
): Promise<ToolFile> {
  const doc = await openPdf(await buf(files[0]));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = Number(opts.fontSize) || 12;
  const pages = doc.getPages();
  const total = pages.length;

  pages.forEach((page, i) => {
    const label =
      opts.format === "n_of_N" ? `${i + 1} of ${total}` : `${i + 1}`;
    const frame = pageFrame(page);
    const textWidth = font.widthOfTextAtSize(label, size);
    const margin = Math.min(28, frame.width / 10, frame.height / 10);
    let u = frame.width / 2 - textWidth / 2;
    if (opts.position === "bottom-right") u = frame.width - textWidth - margin;
    else if (opts.position === "bottom-left") u = margin;
    const { x, y } = frame.toPdf(u, Math.max(2, margin - size / 2));
    page.drawText(label, {
      x,
      y,
      size,
      font,
      color: rgb(0.2, 0.2, 0.2),
      rotate: degrees(frame.angle(0)),
    });
  });
  return { blob: pdfBlob(await doc.save()), filename: suffixed(files[0], "numbered") };
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

/** Renders one line of text to a tightly cropped transparent PNG (browser only). */
async function renderTextPng(text: string, color: string): Promise<Uint8Array> {
  if (typeof document === "undefined") throw new Error("Use Latin letters for the watermark.");
  const px = 160;
  const fontSpec = `bold ${px}px system-ui, "Segoe UI", "Noto Sans", Arial, sans-serif`;
  const canvas = document.createElement("canvas");
  let ctx = canvas.getContext("2d")!;
  ctx.font = fontSpec;
  const m = ctx.measureText(text);
  const ascent = Math.ceil(m.actualBoundingBoxAscent || px * 0.8);
  const descent = Math.ceil(m.actualBoundingBoxDescent || px * 0.2);
  canvas.width = Math.max(1, Math.ceil(m.width));
  canvas.height = ascent + descent;
  ctx = canvas.getContext("2d")!;
  ctx.font = fontSpec;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(text, 0, ascent);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't draw that watermark.");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function watermarkTool(
  files: File[],
  opts: { text: string; opacity: string; color: string; fontSize: string }
): Promise<ToolFile> {
  const doc = await openPdf(await buf(files[0]));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = (opts.text ?? "").trim();
  if (!text) throw new Error("Type the watermark text.");
  const size = Number(opts.fontSize) || 60;
  const opacity = Number(opts.opacity) || 0.25;
  const hex = /^#[0-9a-f]{6}$/i.test(opts.color) ? opts.color : "#6d28d9";
  const color = hexToRgb(hex);

  // The standard fonts only cover Latin-1. Anything else (Cyrillic, Greek,
  // CJK, emoji…) is drawn by the browser into an image instead.
  let latin = true;
  try {
    font.encodeText(text);
  } catch {
    latin = false;
  }
  const image = latin ? null : await doc.embedPng(await renderTextPng(text, hex));
  // Text box at size 1: width per point of font size, and the visual height.
  const unitWidth = image ? image.width / image.height : font.widthOfTextAtSize(text, 1);
  const unitHeight = image ? 1 : 0.72; // Helvetica cap height

  const theta = Math.PI / 4;
  for (const page of doc.getPages()) {
    const frame = pageFrame(page);
    // Shrink long text so the diagonal stays on the page.
    const room = (0.9 * Math.min(frame.width, frame.height)) / Math.cos(theta);
    const s = Math.min(size, room / (unitWidth + unitHeight));
    const w = unitWidth * s;
    const h = unitHeight * s;
    // Start point that centres the rotated box on the page.
    const u = frame.width / 2 - (w / 2) * Math.cos(theta) + (h / 2) * Math.sin(theta);
    const v = frame.height / 2 - (w / 2) * Math.sin(theta) - (h / 2) * Math.cos(theta);
    const { x, y } = frame.toPdf(u, v);
    const rotate = degrees(frame.angle(45));
    if (image) {
      page.drawImage(image, { x, y, width: w, height: h, opacity, rotate });
    } else {
      page.drawText(text, { x, y, size: s, font, color, opacity, rotate });
    }
  }
  return { blob: pdfBlob(await doc.save()), filename: suffixed(files[0], "watermarked") };
}

// ---------------------------------------------------------------------------
// Layout-aware extraction (see lib/pdf/parse.ts)
// ---------------------------------------------------------------------------

/** Per-page progress for long documents; silent for short ones. */
function pageProgress(ctx: ToolContext) {
  return (page: number, total: number) => {
    if (total >= 10) ctx.progress?.(page / total, `Page ${page} of ${total}`);
  };
}

/** Fails instead of handing back an empty file when a PDF has no text layer. */
function requireText(out: string): string {
  if (!out.trim()) throw new Error(SCANNED_MESSAGE);
  return out;
}

/** PDF -> text, in correct reading order (handles multi-column layouts). */
export async function pdfToTextTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx), ctx.signal);
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([requireText(toPlainText(doc))], { type: "text/plain" }),
    filename: `${base}.txt`,
  };
}

/** PDF -> Markdown, preserving headings, lists, and tables. */
export async function pdfToMarkdownTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx), ctx.signal);
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([requireText(toMarkdown(doc))], { type: "text/markdown" }),
    filename: `${base}.md`,
  };
}

/** Detect tables and export each as CSV. */
export async function extractTablesTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile[]> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx), ctx.signal);
  const tables = extractTables(doc);
  if (!tables.length) {
    throw new Error(doc.likelyScanned ? SCANNED_MESSAGE : NO_TABLES_MESSAGE);
  }
  const base = files[0].name.replace(/\.pdf$/i, "");
  return tables.map((table, i) => ({
    blob: new Blob([tableToCsv(table)], { type: "text/csv" }),
    filename: `${base}-table-${i + 1}-p${table.page}.csv`,
  }));
}

/** Split into retrieval-sized chunks with heading breadcrumbs, for RAG. */
export async function pdfToChunksTool(
  files: File[],
  opts: { maxChars: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx), ctx.signal);
  const chunks = toChunks(doc, Number(opts.maxChars) || 1200);
  if (!chunks.length) throw new Error(SCANNED_MESSAGE);
  const base = files[0].name.replace(/\.pdf$/i, "");
  const payload = {
    source: files[0].name,
    pageCount: doc.pageCount,
    chunkCount: chunks.length,
    chunks,
  };
  return {
    blob: new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    }),
    filename: `${base}-chunks.json`,
  };
}

// ---------------------------------------------------------------------------
// Progress reporting for long-running tools (OCR)
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** fraction in 0..1, plus a short human label */
  progress?: (fraction: number, label: string) => void;
  /** Aborted when the person cancels or leaves; long tools stop early. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export async function protectTool(
  files: File[],
  opts: { password: string; confirm: string; printing: string; copying: string }
): Promise<ToolFile> {
  if (!opts.password) throw new Error("Please enter a password.");
  if (opts.password.length < 4) throw new Error("Use at least 4 characters.");
  if (opts.password !== opts.confirm) throw new Error("The passwords don't match.");
  const { protectPdf } = await import("./security");
  const out = await protectPdf(await buf(files[0]), {
    userPassword: opts.password,
    allowPrinting: opts.printing === "yes",
    allowCopying: opts.copying === "yes",
  });
  const base = files[0].name.replace(/\.pdf$/i, "");
  return { blob: pdfBlob(out), filename: `${base}-protected.pdf` };
}

export async function unlockTool(
  files: File[],
  opts: { password: string }
): Promise<ToolFile> {
  const { unlockPdf, isEncrypted } = await import("./security");
  const bytes = await buf(files[0]);
  const encrypted = await isEncrypted(bytes).catch((err) => {
    throw friendlyPdfError(err);
  });
  if (!encrypted) {
    // The encryption check reads only the header and trailer, so a damaged
    // file would pass as an unprotected one: open it properly first.
    await openPdf(bytes)
      .then((d) => d.getPageCount())
      .catch((err) => {
        throw friendlyPdfError(err);
      });
    throw new Error("This PDF isn't password-protected — there's nothing to unlock.");
  }
  let out: Uint8Array;
  try {
    out = await unlockPdf(bytes, opts.password);
  } catch (err) {
    // An owner-only file opens with an empty password, so only blame the
    // empty field once it has been tried.
    if (!opts.password) throw new Error("Enter the PDF's password.");
    throw err;
  }
  const base = files[0].name.replace(/\.pdf$/i, "");
  return { blob: pdfBlob(out), filename: `${base}-unlocked.pdf` };
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

/**
 * The PDF to add text to, or null when pdf-lib can't edit it. One restricted
 * by an owner password only opens without a password, so it is decrypted and
 * keeps its pages as they are.
 */
export async function openForTextLayer(bytes: Uint8Array): Promise<PDFDocument | null> {
  try {
    return await openPdf(bytes);
  } catch {
    // Damaged, or it needs a password.
    return null;
  }
}

export async function ocrTool(
  files: File[],
  opts: { lang: string; output: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  const { ocrDocument, ocrText } = await import("./ocr");
  const bytes = await buf(files[0]);
  const base = files[0].name.replace(/\.pdf$/i, "");
  const onProgress = (p: OcrProgress) => {
    const label =
      p.stage === "loading"
        ? "Loading the OCR engine…"
        : `Reading page ${p.page} of ${p.total}…`;
    ctx.progress?.(((p.page - 1) + p.pageProgress) / p.total, label);
  };
  const { signal } = ctx;
  if (opts.output === "text") {
    const pages = await ocrDocument(bytes, { lang: opts.lang, onProgress, signal });
    return {
      blob: new Blob([ocrText(pages)], { type: "text/plain" }),
      filename: `${base}-ocr.txt`,
    };
  }

  // Keep the original pages and add only the text, so the file stays as
  // sharp and about as small as it came. A PDF pdf-lib can't edit is rebuilt
  // from page images instead.
  const original = await openForTextLayer(bytes);
  const { addTextLayer, buildSearchablePdf } = await import("./ocr-layer");
  if (!original) {
    const pages = await ocrDocument(bytes, { lang: opts.lang, onProgress, signal, images: true });
    ctx.progress?.(1, "Building searchable PDF…");
    return { blob: pdfBlob(await buildSearchablePdf(pages)), filename: `${base}-searchable.pdf` };
  }
  const pages = await ocrDocument(bytes, { lang: opts.lang, onProgress, signal, newWordsOnly: true });
  if (!pages.some((p) => p?.words.length)) {
    // Pages left unread, or words left out, mean the text is there already.
    const there = pages.some((p) => !p || p.known);
    throw new Error(there ? "This PDF can already be searched and copied. To get its text, use PDF to Text." : "No text found in this PDF.");
  }
  ctx.progress?.(1, "Building searchable PDF…");
  return { blob: pdfBlob(await addTextLayer(original, pages)), filename: `${base}-searchable.pdf` };
}

// ---------------------------------------------------------------------------
// Office conversions
// ---------------------------------------------------------------------------

export async function pdfToWordTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx), ctx.signal);
  if (doc.likelyScanned) {
    throw new Error(SCANNED_MESSAGE);
  }
  const { toDocxBlob } = await import("./convert");
  const base = files[0].name.replace(/\.pdf$/i, "");
  return { blob: await toDocxBlob(doc, base), filename: `${base}.docx` };
}

export async function pdfToExcelTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx), ctx.signal);
  const tables = extractTables(doc);
  if (!tables.length) {
    throw new Error(doc.likelyScanned ? SCANNED_MESSAGE : NO_TABLES_MESSAGE);
  }
  const { tablesToXlsx } = await import("./convert");
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([(await tablesToXlsx(tables)).slice() as unknown as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename: `${base}.xlsx`,
  };
}
