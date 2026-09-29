import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { configureWorker } from "../pdf/worker";
import type { ToolContext, ToolFile } from "../pdf/toolkit";
import {
  EMU_PER_PT,
  MAX_SLIDE_EMU,
  MIN_SLIDE_EMU,
  writePptx,
  type PptxFrame,
  type PptxSlide,
} from "./write";

/**
 * PDF -> PowerPoint: each page becomes a slide holding a picture of the page.
 * The page text goes into the picture's alt text so the deck stays
 * accessible and searchable.
 */

export type PptxQuality = "standard" | "high";

export const QUALITY: Record<PptxQuality, { dpi: number; jpeg: number }> = {
  standard: { dpi: 150, jpeg: 0.85 },
  high: { dpi: 220, jpeg: 0.92 },
};

/** Browsers (iOS Safari especially) refuse canvases much larger than this. */
export const MAX_CANVAS_PIXELS = 16_000_000;
export const MAX_CANVAS_SIDE = 8192;
export const ALT_TEXT_MAX = 1000;

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** Slide size (EMU) for a page in points, clamped to PowerPoint's 1–56 inch range. */
export function slideSizeFor(widthPt: number, heightPt: number): { cx: number; cy: number } {
  let cx = widthPt * EMU_PER_PT;
  let cy = heightPt * EMU_PER_PT;
  // Shrink oversized pages proportionally first, so the aspect ratio survives.
  const down = Math.min(1, MAX_SLIDE_EMU / cx, MAX_SLIDE_EMU / cy);
  cx *= down;
  cy *= down;
  const up = Math.max(1, MIN_SLIDE_EMU / cx, MIN_SLIDE_EMU / cy);
  if (cx * up <= MAX_SLIDE_EMU && cy * up <= MAX_SLIDE_EMU) {
    cx *= up;
    cy *= up;
  }
  const clamp = (v: number) => Math.round(Math.min(MAX_SLIDE_EMU, Math.max(MIN_SLIDE_EMU, v)));
  return { cx: clamp(cx), cy: clamp(cy) };
}

/** Largest frame with the page's aspect ratio that fits the slide, centred. */
export function fitFrame(pageW: number, pageH: number, slideW: number, slideH: number): PptxFrame {
  const scale = Math.min(slideW / pageW, slideH / pageH);
  const cx = Math.round(pageW * scale);
  const cy = Math.round(pageH * scale);
  return { x: Math.round((slideW - cx) / 2), y: Math.round((slideH - cy) / 2), cx, cy };
}

/** Render scale for a DPI, reduced when the canvas would be too large. */
export function renderScale(widthPt: number, heightPt: number, dpi: number): number {
  let scale = dpi / 72;
  const w = widthPt * scale;
  const h = heightPt * scale;
  const shrink = Math.min(1, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h, Math.sqrt(MAX_CANVAS_PIXELS / (w * h)));
  scale *= shrink;
  return scale;
}

export interface TextItemLike {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  height?: number;
}

/**
 * Page text in content order (how the author wrote it, which is reading order
 * for nearly all generated PDFs), with line breaks where the baseline jumps.
 */
export function pageText(items: TextItemLike[], max = ALT_TEXT_MAX): string {
  let out = "";
  let lastY: number | null = null;
  let lastSize = 0;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    const size = Math.abs(item.transform?.[3] ?? item.height ?? 0) || lastSize;
    if (item.str && lastY !== null && y !== undefined && Math.abs(y - lastY) > Math.max(lastSize, size) * 0.5) {
      out += "\n";
    } else if (item.str && out && !/\s$/.test(out) && !/^\s/.test(item.str)) {
      out += " ";
    }
    out += item.str;
    if (item.hasEOL) out += "\n";
    if (item.str && y !== undefined) {
      lastY = y;
      lastSize = size;
    }
  }
  const lines = out
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let text = lines.join("\n");
  if (text.length > max) {
    const cut = text.slice(0, max - 1);
    const space = cut.search(/\s\S*$/);
    text = (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
  }
  return text;
}

/** Turns a rendered page into image bytes. Swappable so Node tests can use node-canvas. */
export type PageRasterizer = (
  page: PDFPageProxy,
  scale: number,
  jpegQuality: number
) => Promise<Uint8Array>;

/** Browser rasterizer: pdf.js onto a canvas, then JPEG. */
export const canvasRasterizer: PageRasterizer = async (page, scale, jpegQuality) => {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Your browser couldn't create a drawing surface.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", jpegQuality)
  );
  // Free the backing store right away; 40-page decks otherwise pile up memory.
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("Couldn't render a page of this PDF.");
  return new Uint8Array(await blob.arrayBuffer());
};

export interface PdfToPptxOptions {
  quality?: PptxQuality;
  title?: string;
  onProgress?: (fraction: number, label: string) => void;
  rasterize?: PageRasterizer;
  /** For reproducible output in tests. */
  date?: Date;
  /** Where pdf.js finds the standard 14 fonts (needed outside the browser). */
  standardFontDataUrl?: string;
}

async function openPdf(data: Uint8Array, standardFontDataUrl?: string): Promise<PDFDocumentProxy> {
  const pdfjsLib = await import("pdfjs-dist");
  configureWorker(pdfjsLib);
  try {
    // pdf.js detaches the buffer it is given, so pass a private copy.
    return await pdfjsLib.getDocument({ data: data.slice(), standardFontDataUrl }).promise;
  } catch (err) {
    if ((err as { name?: string })?.name === "PasswordException") {
      throw new Error("This PDF is password-protected. Unlock it first, then convert.");
    }
    throw new Error("Couldn't open that PDF. It may be damaged.");
  }
}

export async function pdfToPptx(data: Uint8Array, opts: PdfToPptxOptions = {}): Promise<Uint8Array> {
  const quality = QUALITY[opts.quality ?? "standard"] ?? QUALITY.standard;
  const rasterize = opts.rasterize ?? canvasRasterizer;
  const doc = await openPdf(data, opts.standardFontDataUrl);
  try {
    const total = doc.numPages;
    const slides: PptxSlide[] = [];
    let size: { cx: number; cy: number } | null = null;

    for (let i = 1; i <= total; i++) {
      opts.onProgress?.((i - 1) / total, `Page ${i} of ${total}`);
      const page = await doc.getPage(i);
      // The scale-1 viewport accounts for /Rotate, so sizes match what readers show.
      const base = page.getViewport({ scale: 1 });
      if (!size) size = slideSizeFor(base.width, base.height);

      const image = await rasterize(page, renderScale(base.width, base.height, quality.dpi), quality.jpeg);
      let altText = "";
      try {
        altText = pageText((await page.getTextContent()).items as TextItemLike[]);
      } catch {
        // Text is a bonus; a page whose text can't be read still converts.
      }
      page.cleanup();

      slides.push({
        image,
        format: "jpeg",
        frame: fitFrame(base.width, base.height, size.cx, size.cy),
        altText: altText || `Page ${i}`,
      });
    }
    if (!size) throw new Error("This PDF has no pages.");

    opts.onProgress?.(1, "Building slides");
    return await writePptx({
      width: size.cx,
      height: size.cy,
      slides,
      title: opts.title,
      date: opts.date,
    });
  } finally {
    doc.destroy();
  }
}

export async function pdfToPptxTool(
  files: File[],
  opts: { quality: string },
  ctx: ToolContext = {}
): Promise<ToolFile> {
  const file = files[0];
  const base = file.name.replace(/\.pdf$/i, "") || "slides";
  const bytes = await pdfToPptx(new Uint8Array(await file.arrayBuffer()), {
    quality: opts.quality === "high" ? "high" : "standard",
    title: base,
    onProgress: ctx.progress,
  });
  // No copy: decks can run to hundreds of MB, and the bytes are ours alone.
  return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: PPTX_MIME }), filename: `${base}.pptx` };
}
