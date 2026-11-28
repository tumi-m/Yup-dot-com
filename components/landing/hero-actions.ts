/** The tools the homepage offers for the files dropped on it. */

import { fileKind, MARKDOWN_NAME } from "@/lib/journey";
import { limitsFor, type Tier } from "@/lib/limits";
import { OFFICE_ENABLED, officeAccept } from "@/lib/office";
import { HTML_TO_PDF_ENABLED } from "@/lib/web-pdf";
import { acceptFor, ALL_FORMATS } from "@/lib/pdf/images-to-pdf/formats";

export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * What the PDF branch's file picker offers: PDFs, pictures and text, and
 * the Word, Excel and HTML files that are handed to their tools while those
 * are on, as a drop on the homepage is.
 */
export function pdfPickerAccept(on: { office: boolean; html: boolean } = { office: OFFICE_ENABLED, html: HTML_TO_PDF_ENABLED }): string {
  return [
    "application/pdf",
    acceptFor(ALL_FORMATS),
    "text/plain,text/markdown,.txt,.md,.markdown",
    ...(on.office ? [officeAccept("word-to-pdf"), officeAccept("excel-to-pdf")] : []),
    ...(on.html ? [".html,.htm,text/html"] : []),
  ].join(",");
}

export const PDF_ACTIONS = [
  "edit-pdf",
  "edit-pdf-text",
  "sign-pdf",
  "compress-pdf",
  "pdf-to-word",
  "pdf-to-pptx",
  "chat-with-pdf",
  "ocr-pdf",
  "split-pdf",
  "organize-pdf",
  "protect-pdf",
  "redact-pdf",
];
/**
 * Several PDFs: only tools that take them all. Any other tool would keep the
 * first and quietly drop the rest.
 */
export const MULTI_ACTIONS = ["merge-pdf"];
/** Exactly two PDFs: they can be compared too, the first as the original. */
export const TWO_ACTIONS = ["merge-pdf", "compare-pdf"];
export const IMAGE_ACTIONS = ["jpg-to-pdf"];
/** Pictures all of one format with a page of its own go there, named for it. */
const FORMAT_PAGES: [RegExp, string][] = [
  [/\.png$|^image\/png$/, "png-to-pdf"],
  [/\.webp$|^image\/webp$/, "webp-to-pdf"],
  [/\.hei[cf]$|^image\/hei[cf]$/, "heic-to-pdf"],
  [/\.tiff?$|^image\/tiff$/, "tiff-to-pdf"],
  [/\.svg$|^image\/svg\+xml$/, "svg-to-pdf"],
];
/** A text or Markdown file: one at a time, laid out as pages. */
export const TEXT_ACTIONS = ["txt-to-pdf", "markdown-to-pdf"];
export const MARKDOWN_ACTIONS = ["markdown-to-pdf", "txt-to-pdf"];
/** A CSV: as a table (Excel to PDF, while it is on) or as text. */
export const CSV_ACTIONS = ["excel-to-pdf", "txt-to-pdf"];
/**
 * PDFs and images together: no tool takes both. Merge PDF would drop the
 * images and could be left with one file, so the panel says to pick one kind.
 */
export const MIXED_ACTIONS: string[] = [];
export const PPTX_ACTIONS = ["pptx-to-pdf", "edit-pptx"];

/** Tools handed every file; the others get the first. */
export const TAKES_ALL = ["merge-pdf", "compare-pdf", "jpg-to-pdf", ...FORMAT_PAGES.map(([, slug]) => slug)];

export function heroActions(mode: "pdf" | "pptx", files: { name: string; type: string }[], office = OFFICE_ENABLED): string[] {
  if (mode === "pptx") return PPTX_ACTIONS;
  // By name too: a photo from a share sheet or a phone picker can come without a type.
  const images = files.filter((f) => fileKind(f) === "image").length;
  const texts = files.filter((f) => fileKind(f) === "text").length;
  if (files.length > 0 && images === files.length) {
    const page = FORMAT_PAGES.find(([test]) => files.every((f) => test.test(f.name.toLowerCase()) || test.test(f.type.toLowerCase())));
    return page ? [page[1]] : IMAGE_ACTIONS;
  }
  // The text tools take one file: the first, Markdown or not.
  if (files.length > 0 && texts === files.length && office && /\.csv$/i.test(files[0].name)) return CSV_ACTIONS;
  if (files.length > 0 && texts === files.length) return MARKDOWN_NAME.test(files[0].name) || /markdown/.test(files[0].type) ? MARKDOWN_ACTIONS : TEXT_ACTIONS;
  if (images > 0 || texts > 0) return MIXED_ACTIONS;
  return files.length === 2 ? TWO_ACTIONS : files.length > 1 ? MULTI_ACTIONS : PDF_ACTIONS;
}

/**
 * The type a file is handed to a tool with. Browsers often leave it empty
 * (Office files, photos from a share sheet), and the handoff would then call
 * the file a PDF.
 */
export function handoffType(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const kind = fileKind(file);
  if (kind === "image") {
    const ext = file.name.toLowerCase().match(/\.(\w+)$/)?.[1] ?? "";
    return IMAGE_TYPE_BY_EXT[ext] ?? "image/jpeg";
  }
  if (kind === "text") return MARKDOWN_NAME.test(file.name) ? "text/markdown" : "text/plain";
  return kind === "pptx" ? PPTX_TYPE : "application/pdf";
}

const IMAGE_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  svg: "image/svg+xml",
};

type Picked = { name: string; size: number; lastModified: number };

/**
 * Files picked or dropped again join the ones already chosen, so one PDF and
 * then another reach Merge PDF. The same file twice counts once.
 */
export function addFiles<T extends Picked>(current: T[], incoming: T[]): T[] {
  const same = (a: Picked, b: Picked) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  const fresh = incoming.filter((f, i) => !current.some((c) => same(c, f)) && incoming.findIndex((g) => same(g, f)) === i);
  return fresh.length ? [...current, ...fresh] : current;
}

/** Files over the plan's size limit: a tool would turn them away on arrival. */
export function tooBigFor<T extends { size: number }>(tier: Tier, files: T[]): T[] {
  const max = limitsFor(tier).maxFileBytes;
  return files.filter((f) => f.size > max);
}

/**
 * One pick or drop on the PDF branch. Files over the limit are turned away
 * as they arrive, as on a tool page, so the ones that fit (and those already
 * chosen) keep their tools. `join` adds to the files there instead of
 * starting afresh.
 */
export function takePdfs<T extends Picked>(
  tier: Tier,
  current: T[],
  incoming: T[],
  join: boolean
): { files: T[]; tooBig: T[] } {
  const tooBig = tooBigFor(tier, incoming);
  const fits = incoming.filter((f) => !tooBig.includes(f));
  return { files: join ? addFiles(current, fits) : fits, tooBig };
}
