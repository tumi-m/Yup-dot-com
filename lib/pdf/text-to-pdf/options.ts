/**
 * The choices on the Text and Markdown to PDF pages, read from the form's
 * strings into a page setup. Plain numbers only, so the page can import it.
 */
import type { PageSetup } from "./layout";

export interface TextToPdfOptions {
  /** "a4" or "letter". */
  pageSize: string;
  /** "narrow", "normal" or "wide". */
  margin: string;
  /** In points, "9" to "14". */
  fontSize: string;
  /** "sans" or "mono". */
  font: string;
  /** "true" to number the pages. */
  pageNumbers: string;
}

export const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

export const MARGINS: Record<string, number> = { narrow: 36, normal: 72, wide: 108 };

export const FONT_SIZES = ["9", "10", "11", "12", "14"];

export function readTextOptions(o: Partial<TextToPdfOptions>): { setup: PageSetup; size: number; mono: boolean } {
  const page = PAGE_SIZES[o.pageSize ?? ""] ?? PAGE_SIZES.a4;
  const size = Number(o.fontSize);
  return {
    setup: { ...page, margin: MARGINS[o.margin ?? ""] ?? MARGINS.normal, pageNumbers: o.pageNumbers === "true" },
    size: Number.isFinite(size) && size >= 6 && size <= 24 ? size : 11,
    mono: o.font === "mono",
  };
}
