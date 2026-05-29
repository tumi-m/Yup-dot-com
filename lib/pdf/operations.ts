import {
  PDFDocument,
  rgb,
  degrees,
  StandardFonts,
  type PDFPage,
} from "pdf-lib";
import type { Annotation } from "@/lib/types";

/** Convert a #rrggbb hex string to a pdf-lib rgb() colour. */
function hexToRgb(hex: string) {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return rgb(
    Number.isFinite(r) ? r : 0,
    Number.isFinite(g) ? g : 0,
    Number.isFinite(b) ? b : 0
  );
}

export async function loadPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

/** Number of pages without fully parsing render data. */
export async function getPageCount(bytes: ArrayBuffer | Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

/** Merge multiple PDFs (as byte arrays) into a single document. */
export async function mergePdfs(parts: (ArrayBuffer | Uint8Array)[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/**
 * Split a PDF into a new document containing only the given (0-indexed) pages,
 * in the order provided. Used for both "extract" and "reorder".
 */
export async function extractPages(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[]
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageIndices);
  copied.forEach((p) => out.addPage(p));
  return out.save();
}

/** Delete the given (0-indexed) pages, returning a new document. */
export async function deletePages(
  bytes: ArrayBuffer | Uint8Array,
  pagesToDelete: number[]
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const remove = new Set(pagesToDelete);
  const keep = src.getPageIndices().filter((i) => !remove.has(i));
  return extractPages(bytes, keep);
}

/** Rotate specific pages by a multiple of 90 degrees (relative). */
export async function rotatePages(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[],
  delta: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const targets = new Set(pageIndices);
  doc.getPages().forEach((page, i) => {
    if (targets.has(i)) {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + delta) % 360));
    }
  });
  return doc.save();
}

/** Reorder pages given a full ordering of (0-indexed) page positions. */
export async function reorderPages(
  bytes: ArrayBuffer | Uint8Array,
  newOrder: number[]
): Promise<Uint8Array> {
  return extractPages(bytes, newOrder);
}

/**
 * Bake the in-editor annotations into the PDF and return the new bytes.
 * Annotation coordinates use a top-left origin in PDF points; pdf-lib uses a
 * bottom-left origin, so we flip the y-axis here.
 */
export async function applyAnnotations(
  bytes: ArrayBuffer | Uint8Array,
  annotations: Annotation[],
  options: { watermark?: boolean } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();

  for (const ann of annotations) {
    const page = pages[ann.page];
    if (!page) continue;
    const { height: ph } = page.getSize();

    switch (ann.type) {
      case "text": {
        page.drawText(ann.text, {
          x: ann.x,
          y: ph - ann.y - ann.fontSize,
          size: ann.fontSize,
          font,
          color: hexToRgb(ann.color),
        });
        break;
      }
      case "highlight": {
        page.drawRectangle({
          x: ann.x,
          y: ph - ann.y - ann.height,
          width: ann.width,
          height: ann.height,
          color: hexToRgb(ann.color),
          opacity: ann.opacity,
        });
        break;
      }
      case "draw": {
        if (ann.points.length < 2) break;
        for (let i = 1; i < ann.points.length; i++) {
          const a = ann.points[i - 1];
          const b = ann.points[i];
          page.drawLine({
            start: { x: ann.x + a.x, y: ph - (ann.y + a.y) },
            end: { x: ann.x + b.x, y: ph - (ann.y + b.y) },
            thickness: ann.strokeWidth,
            color: hexToRgb(ann.color),
          });
        }
        break;
      }
      case "signature": {
        try {
          const png = await doc.embedPng(ann.dataUrl);
          page.drawImage(png, {
            x: ann.x,
            y: ph - ann.y - ann.height,
            width: ann.width,
            height: ann.height,
          });
        } catch {
          // Ignore malformed signature images rather than failing the export.
        }
        break;
      }
    }
  }

  if (options.watermark) {
    for (const page of pages) {
      const { width, height } = page.getSize();
      page.drawText("Made with Yup", {
        x: width / 2 - 70,
        y: 16,
        size: 9,
        font,
        color: rgb(0.6, 0.6, 0.6),
        opacity: 0.6,
      });
      void height;
    }
  }

  return doc.save();
}
