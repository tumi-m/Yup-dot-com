import { LIMITS } from "../limits";

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

/** The most document text any plan reads. The browser never sends more. */
export const MAX_DOCUMENT_CHARS = Math.max(...Object.values(LIMITS).map((l) => l.aiDocumentChars));

export interface SentDocument {
  documentText: string;
  /** The PDF's page count, set only when the text leaves pages out. */
  totalPages?: number;
}

/**
 * What the browser sends with each question: whole pages up to the largest
 * plan's budget. The server reads no more than that, and a long PDF's full
 * text went over the request size limit, so every question failed.
 */
export function documentToSend(text: string, pageCount: number): SentDocument {
  const fitted = fitDocument(text, MAX_DOCUMENT_CHARS);
  return fitted.truncated ? { documentText: fitted.text, totalPages: pageCount } : { documentText: text };
}

/**
 * Fits what the browser sent to the plan's budget. When the browser already
 * left pages out, the model is still told how many pages the PDF has.
 */
export function fitSentDocument(text: string, maxChars: number, totalPages?: number): FittedDocument {
  const fitted = fitDocument(text, maxChars);
  if (!totalPages) return fitted;
  return { ...fitted, totalPages: Math.max(totalPages, fitted.totalPages ?? 0), truncated: true };
}
