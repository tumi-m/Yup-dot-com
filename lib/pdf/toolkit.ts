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

async function buf(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/** Parse "1-3, 5, 8-10" into a list of 0-indexed page arrays (one per range). */
export function parseRanges(input: string, pageCount: number): number[][] {
  const ranges: number[][] = [];
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const start = Math.max(1, parseInt(m[1], 10));
      const end = Math.min(pageCount, parseInt(m[2], 10));
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
    const src = await PDFDocument.load(await buf(file));
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return { blob: pdfBlob(await out.save()), filename: "merged.pdf" };
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

  let groups: number[][];
  if (opts.mode === "every") {
    groups = src.getPageIndices().map((i) => [i]);
  } else {
    groups = parseRanges(opts.ranges || `1-${count}`, count);
    if (!groups.length) groups = [src.getPageIndices()];
  }

  const results: ToolFile[] = [];
  for (let g = 0; g < groups.length; g++) {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, groups[g]);
    copied.forEach((p) => out.addPage(p));
    results.push({
      blob: pdfBlob(await out.save()),
      filename: `split-${g + 1}.pdf`,
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
  opts: { quality: string }
): Promise<ToolFile> {
  const quality = Number(opts.quality) || 0.6;
  const bytes = await buf(files[0]);
  const loaded = await loadForRender(bytes);
  const out = await PDFDocument.create();
  // Render at ~150 DPI equivalent for a sensible size/quality balance.
  const scale = 1.5;

  for (let i = 1; i <= loaded.numPages; i++) {
    const vp = await loaded.getPageViewport(i, scale);
    const canvas = document.createElement("canvas");
    await loaded.renderPage(i, canvas, scale);
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const img = await out.embedJpg(dataUrl);
    // Place at the page's true point size (vp at scale 1).
    const pageW = vp.baseWidth;
    const pageH = vp.baseHeight;
    const page = out.addPage([pageW, pageH]);
    page.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH });
  }
  loaded.destroy();
  return { blob: pdfBlob(await out.save()), filename: "compressed.pdf" };
}

// ---------------------------------------------------------------------------
// PDF -> images
// ---------------------------------------------------------------------------
export async function pdfToImagesTool(
  files: File[],
  opts: { format: string; quality: string }
): Promise<ToolFile[]> {
  const format = opts.format === "png" ? "png" : "jpeg";
  const quality = Number(opts.quality) || 0.92;
  const bytes = await buf(files[0]);
  const loaded = await loadForRender(bytes);
  const base = files[0].name.replace(/\.pdf$/i, "");
  const results: ToolFile[] = [];

  for (let i = 1; i <= loaded.numPages; i++) {
    const canvas = document.createElement("canvas");
    await loaded.renderPage(i, canvas, 2);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, `image/${format}`, quality)
    );
    if (blob) {
      results.push({
        blob,
        filename: `${base}-page-${String(i).padStart(2, "0")}.${format === "jpeg" ? "jpg" : "png"}`,
      });
    }
  }
  loaded.destroy();
  return results;
}

// ---------------------------------------------------------------------------
// Images -> PDF
// ---------------------------------------------------------------------------
const A4 = { w: 595.28, h: 841.89 };

export async function imagesToPdfTool(
  files: File[],
  opts: { pageSize: string; margin: string }
): Promise<ToolFile> {
  const out = await PDFDocument.create();
  const margin = Number(opts.margin) || 0;

  for (const file of files) {
    const data = await buf(file);
    const isPng = file.type.includes("png") || file.name.toLowerCase().endsWith(".png");
    const img = isPng ? await out.embedPng(data) : await out.embedJpg(data);

    if (opts.pageSize === "fit") {
      const page = out.addPage([img.width + margin * 2, img.height + margin * 2]);
      page.drawImage(img, { x: margin, y: margin, width: img.width, height: img.height });
    } else {
      const page = out.addPage([A4.w, A4.h]);
      const maxW = A4.w - margin * 2;
      const maxH = A4.h - margin * 2;
      const ratio = Math.min(maxW / img.width, maxH / img.height);
      const w = img.width * ratio;
      const h = img.height * ratio;
      page.drawImage(img, {
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
  return { blob: pdfBlob(await doc.save()), filename: "rotated.pdf" };
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
    const { width } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, size);
    const margin = 28;
    let x = width / 2 - textWidth / 2;
    if (opts.position === "bottom-right") x = width - textWidth - margin;
    else if (opts.position === "bottom-left") x = margin;
    page.drawText(label, {
      x,
      y: margin - size / 2,
      size,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });
  });
  return { blob: pdfBlob(await doc.save()), filename: "numbered.pdf" };
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------
export async function watermarkTool(
  files: File[],
  opts: { text: string; opacity: string; color: string; fontSize: string }
): Promise<ToolFile> {
  const doc = await PDFDocument.load(await buf(files[0]));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = opts.text || "CONFIDENTIAL";
  const size = Number(opts.fontSize) || 60;
  const opacity = Number(opts.opacity) || 0.25;
  const color = hexToRgb(opts.color || "#6d28d9");

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size,
      font,
      color,
      opacity,
      rotate: degrees(45),
    });
  }
  return { blob: pdfBlob(await doc.save()), filename: "watermarked.pdf" };
}

// ---------------------------------------------------------------------------
// Layout-aware extraction (see lib/pdf/parse.ts)
// ---------------------------------------------------------------------------

/** PDF -> text, in correct reading order (handles multi-column layouts). */
export async function pdfToTextTool(files: File[]): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]));
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([toPlainText(doc)], { type: "text/plain" }),
    filename: `${base}.txt`,
  };
}

/** PDF -> Markdown, preserving headings, lists, and tables. */
export async function pdfToMarkdownTool(files: File[]): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]));
  const base = files[0].name.replace(/\.pdf$/i, "");
  return {
    blob: new Blob([toMarkdown(doc)], { type: "text/markdown" }),
    filename: `${base}.md`,
  };
}

/** Detect tables and export each as CSV. */
export async function extractTablesTool(files: File[]): Promise<ToolFile[]> {
  const doc = await parseDocument(await buf(files[0]));
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
  opts: { maxChars: string }
): Promise<ToolFile> {
  const doc = await parseDocument(await buf(files[0]));
  const chunks = toChunks(doc, Number(opts.maxChars) || 1200);
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
