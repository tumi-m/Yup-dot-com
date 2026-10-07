import { PDFDocument, rgb, degrees, StandardFonts, type PDFImage } from "pdf-lib";
import { loadForRender } from "./render";
import {
  parseDocument,
  toMarkdown,
  toPlainText,
  toChunks,
  extractTables,
  tableToCsv,
} from "./parse";
import { friendlyPdfError } from "./errors";
import { pageFrame } from "./page-frame";
import { drawOrientedImage, jpegOrientation, orientedSize, sniffImage } from "./images";

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
  return new Blob([bytes.slice() as unknown as BlobPart], {
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

/**
 * Parse "1-3, 5, 8-10" into a list of 0-indexed page arrays (one per range).
 * Reversed ranges ("5-3") are read as 3-5, open ones ("4-") run to the end,
 * and pages beyond the document are dropped.
 */
export function parseRanges(input: string, pageCount: number): number[][] {
  const ranges: number[][] = [];
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s*[-–]\s*(\d*)$/);
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
export async function mergeTool(files: File[]): Promise<ToolFile> {
  const out = await PDFDocument.create();
  for (const file of files) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(await buf(file));
    } catch (err) {
      throw friendlyPdfError(err, file.name);
    }
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return { blob: pdfBlob(await out.save()), filename: "merged.pdf" };
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
  opts: { mode: string; ranges: string }
): Promise<ToolFile | ToolFile[]> {
  const src = await PDFDocument.load(await buf(files[0]));
  const count = src.getPageCount();
  const base = files[0].name.replace(/\.pdf$/i, "");

  let groups: number[][];
  if (opts.mode === "every") {
    groups = src.getPageIndices().map((i) => [i]);
  } else {
    groups = parseRanges(opts.ranges ?? "", count);
    // Never hand back the whole document as if it were the requested split.
    if (!groups.length) {
      throw new Error(count === 1 ? "This PDF has only 1 page." : `Pick pages between 1 and ${count}.`);
    }
  }

  const results: ToolFile[] = [];
  const used = new Map<string, number>();
  for (let g = 0; g < groups.length; g++) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, groups[g]);
    copied.forEach((p) => out.addPage(p));
    // Repeated ranges ("1, 1") must not overwrite each other in the zip.
    const label = pageLabel(groups[g]);
    const n = (used.get(label) ?? 0) + 1;
    used.set(label, n);
    results.push({
      blob: pdfBlob(await out.save()),
      filename: `${base}-${label}${n > 1 ? `-${n}` : ""}.pdf`,
    });
  }
  return results.length === 1 ? results[0] : results;
}

// ---------------------------------------------------------------------------
// Compress — rasterise each page to JPEG and rebuild. Best for scans and
// image-heavy PDFs; this flattens selectable text (a known trade-off).
// ---------------------------------------------------------------------------
export async function compressTool(
  files: File[],
  opts: { quality: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  const quality = Number(opts.quality) || 0.6;
  const bytes = await buf(files[0]);
  const loaded = await loadForRender(bytes);
  const out = await PDFDocument.create();
  // Render at ~150 DPI equivalent for a sensible size/quality balance.
  const scale = 1.5;

  for (let i = 1; i <= loaded.numPages; i++) {
    ctx.progress?.((i - 1) / loaded.numPages, `Page ${i} of ${loaded.numPages}`);
    const vp = await loaded.getPageViewport(i, scale);
    const canvas = document.createElement("canvas");
    await loaded.renderPage(i, canvas, scale, { pixelRatio: 1 });
    const img = await out.embedJpg(await canvasBytes(canvas, "image/jpeg", quality));
    canvas.width = canvas.height = 0; // release the bitmap now, not at GC time
    // Place at the page's true point size (vp at scale 1).
    const pageW = vp.baseWidth;
    const pageH = vp.baseHeight;
    const page = out.addPage([pageW, pageH]);
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
  }
  loaded.destroy();
  const compressed = await out.save();
  // Rasterising can inflate text-only PDFs. Never hand back a bigger file.
  if (compressed.length >= bytes.length) {
    return { blob: pdfBlob(bytes), filename: files[0].name.replace(/\.pdf$/i, "") + ".pdf" };
  }
  return { blob: pdfBlob(compressed), filename: suffixed(files[0], "compressed") };
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

  for (let i = 1; i <= loaded.numPages; i++) {
    ctx.progress?.((i - 1) / loaded.numPages, `Page ${i} of ${loaded.numPages}`);
    const canvas = document.createElement("canvas");
    await loaded.renderPage(i, canvas, 2, { pixelRatio: 1 });
    const blob = new Blob([(await canvasBytes(canvas, `image/${format}`, quality)) as unknown as BlobPart], {
      type: `image/${format}`,
    });
    canvas.width = canvas.height = 0;
    results.push({
      blob,
      filename: `${base}-page-${String(i).padStart(digits, "0")}.${format === "jpeg" ? "jpg" : "png"}`,
    });
  }
  loaded.destroy();
  return results;
}

// ---------------------------------------------------------------------------
// Images -> PDF
// ---------------------------------------------------------------------------
const A4 = { w: 595.28, h: 841.89 };
const MAX_PAGE_PT = 14400;

export async function imagesToPdfTool(
  files: File[],
  opts: { pageSize: string; margin: string }
): Promise<ToolFile> {
  const out = await PDFDocument.create();
  const margin = Number(opts.margin) || 0;

  for (const file of files) {
    const data = await buf(file);
    const kind = sniffImage(data);
    if (!kind) throw new Error(`${file.name}: use a JPG or PNG image.`);
    let img: PDFImage;
    try {
      img = kind === "png" ? await out.embedPng(data) : await out.embedJpg(data);
    } catch {
      throw new Error(`${file.name}: this image looks damaged.`);
    }
    const orientation = kind === "jpeg" ? jpegOrientation(data) : 1;
    const shown = orientedSize(img, orientation);

    if (opts.pageSize === "fit") {
      // 1 px = 1 pt, capped at the 200-inch page limit PDF viewers enforce.
      const scale = Math.min(1, (MAX_PAGE_PT - margin * 2) / Math.max(shown.width, shown.height));
      const w = shown.width * scale;
      const h = shown.height * scale;
      const page = out.addPage([w + margin * 2, h + margin * 2]);
      drawOrientedImage(page, img, orientation, { x: margin, y: margin, width: w, height: h });
    } else {
      const page = out.addPage([A4.w, A4.h]);
      const maxW = A4.w - margin * 2;
      const maxH = A4.h - margin * 2;
      const ratio = Math.min(maxW / shown.width, maxH / shown.height);
      const w = shown.width * ratio;
      const h = shown.height * ratio;
      drawOrientedImage(page, img, orientation, {
        x: (A4.w - w) / 2,
        y: (A4.h - h) / 2,
        width: w,
        height: h,
      });
    }
  }
  return { blob: pdfBlob(await out.save()), filename: "images.pdf" };
}

// ---------------------------------------------------------------------------
// Rotate
// ---------------------------------------------------------------------------
export async function rotateTool(
  files: File[],
  opts: { angle: string }
): Promise<ToolFile> {
  const delta = Number(opts.angle) || 90;
  const doc = await PDFDocument.load(await buf(files[0]));
  doc.getPages().forEach((page) => {
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
  const doc = await PDFDocument.load(await buf(files[0]));
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
  const doc = await PDFDocument.load(await buf(files[0]));
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

const NO_TEXT = "No text found. This looks like a scanned PDF: run OCR PDF on it first.";

/** Fails instead of handing back an empty file when a PDF has no text layer. */
function requireText(out: string): string {
  if (!out.trim()) throw new Error(NO_TEXT);
  return out;
}

/** PDF -> text, in correct reading order (handles multi-column layouts). */
export async function pdfToTextTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx));
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([requireText(toPlainText(doc))], { type: "text/plain" }),
    filename: `${base}.txt`,
  };
}

/** PDF -> Markdown, preserving headings, lists, and tables. */
export async function pdfToMarkdownTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx));
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([requireText(toMarkdown(doc))], { type: "text/markdown" }),
    filename: `${base}.md`,
  };
}

/** Detect tables and export each as CSV. */
export async function extractTablesTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile[]> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx));
  const tables = extractTables(doc);
  if (!tables.length) {
    throw new Error(
      doc.likelyScanned
        ? "No text found — this looks like a scanned PDF, which needs OCR."
        : "No tables detected in this document."
    );
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
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx));
  const chunks = toChunks(doc, Number(opts.maxChars) || 1200);
  if (!chunks.length) throw new Error(NO_TEXT);
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
  if (!(await isEncrypted(bytes))) {
    throw new Error("This PDF isn't password-protected — there's nothing to unlock.");
  }
  const out = await unlockPdf(bytes, opts.password);
  const base = files[0].name.replace(/\.pdf$/i, "");
  return { blob: pdfBlob(out), filename: `${base}-unlocked.pdf` };
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

export async function ocrTool(
  files: File[],
  opts: { lang: string; output: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  const { ocrDocument, ocrText } = await import("./ocr");
  const pages = await ocrDocument(await buf(files[0]), {
    lang: opts.lang,
    onProgress: (p) => {
      const label =
        p.stage === "loading"
          ? "Loading the OCR engine…"
          : `Reading page ${p.page} of ${p.total}…`;
      ctx.progress?.(((p.page - 1) + p.pageProgress) / p.total, label);
    },
  });
  const base = files[0].name.replace(/\.pdf$/i, "");
  if (opts.output === "text") {
    return {
      blob: new Blob([ocrText(pages)], { type: "text/plain" }),
      filename: `${base}-ocr.txt`,
    };
  }
  ctx.progress?.(1, "Building searchable PDF…");
  const { buildSearchablePdf } = await import("./ocr-layer");
  return { blob: pdfBlob(await buildSearchablePdf(pages)), filename: `${base}-searchable.pdf` };
}

// ---------------------------------------------------------------------------
// Office conversions
// ---------------------------------------------------------------------------

export async function pdfToWordTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx));
  if (doc.likelyScanned) {
    throw new Error("This looks like a scanned PDF. Run OCR PDF on it first, then convert.");
  }
  const { toDocxBlob } = await import("./convert");
  const base = files[0].name.replace(/\.pdf$/i, "");
  return { blob: await toDocxBlob(doc, base), filename: `${base}.docx` };
}

export async function pdfToExcelTool(files: File[], ctx: ToolContext = {}): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]), pageProgress(ctx));
  const tables = extractTables(doc);
  if (!tables.length) {
    throw new Error(
      doc.likelyScanned
        ? "This looks like a scanned PDF. Run OCR PDF on it first."
        : "No tables were detected in this document."
    );
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
