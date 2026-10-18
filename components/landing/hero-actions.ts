/** The tools the homepage offers for the files dropped on it. */

export const PDF_ACTIONS = [
  "edit-pdf",
  "sign-pdf",
  "compress-pdf",
  "pdf-to-word",
  "pdf-to-pptx",
  "chat-with-pdf",
  "ocr-pdf",
  "split-pdf",
  "protect-pdf",
];
/**
 * Several PDFs: only tools that take them all. Any other tool would keep the
 * first and quietly drop the rest.
 */
export const MULTI_ACTIONS = ["merge-pdf"];
export const IMAGE_ACTIONS = ["jpg-to-pdf"];
export const PPTX_ACTIONS = ["pptx-to-pdf", "edit-pptx"];

/** Tools handed every file; the others get the first. */
export const TAKES_ALL = ["merge-pdf", "jpg-to-pdf"];

export function heroActions(mode: "pdf" | "pptx", files: { type: string }[]): string[] {
  if (mode === "pptx") return PPTX_ACTIONS;
  if (files.length > 0 && files.every((f) => f.type.startsWith("image/"))) return IMAGE_ACTIONS;
  return files.length > 1 ? MULTI_ACTIONS : PDF_ACTIONS;
}
