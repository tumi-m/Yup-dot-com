import type { LoadedPdf } from "@/lib/pdf/render";

/** A chosen file is a PDF: by its type, or by its name when the browser gives none. */
export const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

/**
 * Opens a chosen PDF with pdf.js to show its pages. A file with no pages, or
 * a page tree that loops, is turned away now rather than when it is saved.
 */
export async function readPdf(file: File): Promise<LoadedPdf> {
  const { loadForRender } = await import("@/lib/pdf/render");
  const loaded = await loadForRender(new Uint8Array(await file.arrayBuffer()));
  try {
    if (!loaded.numPages) throw new Error("This PDF has no pages.");
    // A page tree that loops shows its first pages and fails further on:
    // reaching the last page finds out now, not when the file is saved.
    await loaded.getPageViewport(loaded.numPages, 1);
  } catch (err) {
    loaded.destroy();
    throw err;
  }
  return loaded;
}
