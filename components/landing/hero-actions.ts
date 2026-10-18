/** The tools the homepage offers for the files dropped on it. */

import { fileKind } from "@/lib/journey";

export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

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
/**
 * PDFs and images together: no tool takes both. Merge PDF would drop the
 * images and could be left with one file, so the panel says to pick one kind.
 */
export const MIXED_ACTIONS: string[] = [];
export const PPTX_ACTIONS = ["pptx-to-pdf", "edit-pptx"];

/** Tools handed every file; the others get the first. */
export const TAKES_ALL = ["merge-pdf", "jpg-to-pdf"];

export function heroActions(mode: "pdf" | "pptx", files: { name: string; type: string }[]): string[] {
  if (mode === "pptx") return PPTX_ACTIONS;
  // By name too: a photo from a share sheet or a phone picker can come without a type.
  const images = files.filter((f) => fileKind(f) === "image").length;
  if (files.length > 0 && images === files.length) return IMAGE_ACTIONS;
  if (images > 0) return MIXED_ACTIONS;
  return files.length > 1 ? MULTI_ACTIONS : PDF_ACTIONS;
}

/**
 * The type a file is handed to a tool with. Browsers often leave it empty
 * (Office files, photos from a share sheet), and the handoff would then call
 * the file a PDF.
 */
export function handoffType(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const kind = fileKind(file);
  if (kind === "image") return /\.png$/i.test(file.name) ? "image/png" : "image/jpeg";
  return kind === "pptx" ? PPTX_TYPE : "application/pdf";
}
