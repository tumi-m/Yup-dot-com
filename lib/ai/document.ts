/**
 * Fits page-tagged document text ("[Page N]" markers, see lib/pdf/parse.ts)
 * into a character budget by keeping whole pages from the start, so the
 * model can say honestly which pages it read.
 */
export interface FittedDocument {
  text: string;
  /** Last page included, or null when the text has no page markers. */
  lastPage: number | null;
  totalPages: number | null;
  truncated: boolean;
}

const MARKER = /^\[Page (\d+)\]$/gm;

export function fitDocument(text: string, maxChars: number): FittedDocument {
  const starts: { index: number; page: number }[] = [];
  for (const m of text.matchAll(MARKER)) starts.push({ index: m.index!, page: Number(m[1]) });
  const totalPages = starts.length ? starts[starts.length - 1].page : null;

  if (text.length <= maxChars) {
    return { text, lastPage: totalPages, totalPages, truncated: false };
  }
  if (!starts.length) {
    return { text: text.slice(0, maxChars), lastPage: null, totalPages: null, truncated: true };
  }
  // The last page that starts within the budget is cut at the next marker.
  let end = 0;
  let lastPage = starts[0].page;
  for (let i = 0; i < starts.length; i++) {
    const next = i + 1 < starts.length ? starts[i + 1].index : text.length;
    if (next > maxChars) break;
    end = next;
    lastPage = starts[i].page;
  }
  // Even the first page is over budget: keep what fits of it.
  if (end === 0) return { text: text.slice(0, maxChars), lastPage: starts[0].page, totalPages, truncated: true };
  return { text: text.slice(0, end).trimEnd(), lastPage, totalPages, truncated: true };
}
