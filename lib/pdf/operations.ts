import { PDFDocument, degrees } from "pdf-lib";

/**
 * Structural page operations. Annotation flattening lives in `bake.ts`.
 */

export async function loadPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

/** Number of pages in a document. */
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
 * Build a new document from the given (0-indexed) pages, in the order given.
 * Backs both "extract" and "reorder".
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

/** Delete the given (0-indexed) pages. */
export async function deletePages(
  bytes: ArrayBuffer | Uint8Array,
  pagesToDelete: number[]
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const remove = new Set(pagesToDelete);
  const keep = src.getPageIndices().filter((i) => !remove.has(i));
  return extractPages(bytes, keep);
}

/** Rotate specific pages by a relative multiple of 90 degrees. */
export async function rotatePages(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[],
  delta: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const targets = new Set(pageIndices);
  doc.getPages().forEach((page, i) => {
    if (targets.has(i)) {
      page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360));
    }
  });
  return doc.save();
}

/** Reorder pages given a full ordering of (0-indexed) positions. */
export async function reorderPages(
  bytes: ArrayBuffer | Uint8Array,
  newOrder: number[]
): Promise<Uint8Array> {
  return extractPages(bytes, newOrder);
}
