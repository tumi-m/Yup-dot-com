/**
 * Turns a parsed document (lib/pdf/parse.ts) into passages to translate,
 * packs them into requests, and puts the translations back into the same
 * structure: headings stay headings, list items items, table cells cells.
 *
 * A passage is a heading, a paragraph (split at sentence ends when it is
 * long), a list item or a table cell. Text with no letters (numbers, dates,
 * amounts) is kept as it is and never sent. The same text twice (a running
 * header, a repeated table heading) is sent once.
 */
import type { Block, ParsedDocument } from "../pdf/parse";
import { chargeFor, MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS, MAX_SEGMENT_CHARS } from "./format";

export interface Segment {
  id: string;
  text: string;
  /** The page it first appears on. */
  page: number;
}

export interface TranslationPlan {
  segments: Segment[];
  /** Characters sent in all. */
  chars: number;
  /** Passage text to its id. */
  ids: Map<string, string>;
}

const LETTER = /\p{L}/u;

/** Spaces as one, and no control characters a document or a model can carry. */
export function cleanPassage(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F￾￿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A sentence ends at . ! ? or the Devanagari stop before a space ("3.5" doesn't
// end one), or at a CJK full stop, which needs no space.
const SENTENCE_END = /[.!?।]+["'”’)\]]*\s+|[。！？]+["'”’)\]」』]*\s*/gu;

/** The text cut after each sentence end; joined again they are the text. */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const to = m.index! + m[0].length;
    out.push(text.slice(from, to));
    from = to;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/**
 * A passage split into pieces of at most `max` characters: whole sentences
 * where they fit, else at spaces, else at `max` (never inside a surrogate pair).
 */
export function splitPassage(text: string, max = MAX_SEGMENT_CHARS): string[] {
  if (text.length <= max) return [text];
  const sentences = sentencesOf(text);
  const pieces: string[] = [];
  let current = "";
  const push = (piece: string) => {
    const t = piece.trim();
    if (t) pieces.push(t);
  };
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > max) {
      push(current);
      current = "";
    }
    if (sentence.length <= max) {
      current += sentence;
      continue;
    }
    // One sentence longer than a piece: at spaces, then anywhere.
    let rest = sentence;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(" ", max);
      if (cut < max / 2) cut = max;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  }
  push(current);
  return pieces;
}

/** Every text of a block, in reading order, with a way to put new text back. */
function mapTexts(block: Block, change: (text: string) => string): Block {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return { ...block, text: change(block.text) };
    case "list":
      return { ...block, items: block.items.map(change) };
    case "table":
      return { ...block, rows: block.rows.map((row) => row.map(change)) };
  }
}

/** The passages of a document, each text once, in reading order. */
export function planTranslation(doc: ParsedDocument): TranslationPlan {
  const segments: Segment[] = [];
  const ids = new Map<string, string>();
  let chars = 0;
  for (const block of doc.blocks) {
    mapTexts(block, (text) => {
      const clean = cleanPassage(text);
      if (!LETTER.test(clean)) return text;
      for (const piece of splitPassage(clean)) {
        if (ids.has(piece)) continue;
        const id = String(segments.length + 1);
        ids.set(piece, id);
        segments.push({ id, text: piece, page: block.page });
        chars += piece.length;
      }
      return text;
    });
  }
  return { segments, chars, ids };
}

/**
 * Requests of passages in reading order, each within the size limits. A
 * passage is never split across two.
 */
export function batchSegments<T extends { text: string }>(
  segments: T[],
  maxChars = MAX_BATCH_CHARS,
  maxSegments = MAX_BATCH_SEGMENTS
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const s of segments) {
    if (current.length && (size + s.text.length > maxChars || current.length >= maxSegments)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(s);
    size += s.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** What translating the passages takes from the allowance, request by request. */
export function chargeForSegments(segments: { text: string }[]): number {
  return batchSegments(segments).reduce((sum, b) => sum + chargeFor(b.reduce((n, s) => n + s.text.length, 0)), 0);
}

export interface Translated {
  doc: ParsedDocument;
  /** Passages left in the original language because no translation came back. */
  missing: Segment[];
}

/**
 * The document with each passage's translation in its place. A passage
 * without one keeps its original text there, so nothing moves out of line.
 * `joiner` goes between the pieces of a split paragraph ("" for languages
 * written without spaces).
 */
export function applyTranslation(
  doc: ParsedDocument,
  plan: TranslationPlan,
  translations: Map<string, string>,
  joiner = " "
): Translated {
  const missing = new Map<string, Segment>();
  const byId = new Map(plan.segments.map((s) => [s.id, s]));
  const blocks = doc.blocks.map((block) =>
    mapTexts(block, (text) => {
      const clean = cleanPassage(text);
      if (!LETTER.test(clean)) return text;
      return splitPassage(clean)
        .map((piece) => {
          const id = plan.ids.get(piece);
          const done = id ? translations.get(id) : undefined;
          if (done) return done;
          const segment = id ? byId.get(id) : undefined;
          if (segment) missing.set(segment.id, segment);
          return piece;
        })
        .join(joiner);
    })
  );
  return { doc: { ...doc, blocks }, missing: [...missing.values()] };
}

/** "page 3", "pages 2 and 5", "pages 1, 4 and 9" */
export function pagesText(pages: number[]): string {
  const list = [...new Set(pages)].sort((a, b) => a - b);
  if (list.length === 1) return `page ${list[0]}`;
  return `pages ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
