/**
 * Compare PDFs: what changed between an original and a changed version.
 * The words of both (read by the parser, see words.ts) are compared over
 * the whole document (diff.ts), the pages paired by what they share
 * (pages.ts), and pictures that look different added as changes of their
 * own (run.ts draws them). Plain data, so this runs in a worker.
 */
import { diffWords, pageAt, type AreaBox, type Change } from "./diff";
import { pairPages, type PagePair } from "./pages";
import { PAGE_TEXT, wordCount, type ReadDocument } from "./words";

export type { Change, ChangeKind, AreaBox, Range } from "./diff";
export type { PagePair } from "./pages";

export interface Summary {
  /** Entries in the list of changes. */
  changes: number;
  changed: number;
  added: number;
  removed: number;
  moved: number;
  pictures: number;
  wordsAdded: number;
  wordsRemoved: number;
  /** Pages of one file with no page in the other, 0-indexed. */
  pagesAdded: number[];
  pagesRemoved: number[];
}

export interface CompareResult {
  changes: Change[];
  pairs: PagePair[];
  summary: Summary;
  /** Pages with no text of their own (scans, drawings), 0-indexed, by file. */
  scanned: { a: number[]; b: number[] };
  /** The word diff ran out of time and lines were lined up first. */
  coarse: boolean;
}

/**
 * Pages without text of their own: no words at all, or next to none and a
 * picture (a scan with a stamped page number). They are compared by how
 * they look. A title page with a few words has text.
 */
export function scannedPages(doc: ReadDocument): number[] {
  return doc.pages.flatMap((p, i) => (p.to === p.from || (p.chars < PAGE_TEXT && p.pictures) ? [i] : []));
}

export function summarise(changes: Change[], pairs: PagePair[]): Summary {
  const count = (kind: Change["kind"]) => changes.filter((c) => c.kind === kind).length;
  const words = (pick: (c: Change) => string) => changes.filter((c) => c.kind !== "moved" && c.kind !== "picture").reduce((n, c) => n + wordCount(pick(c)), 0);
  return {
    changes: changes.length,
    changed: count("changed"),
    added: count("added"),
    removed: count("removed"),
    moved: count("moved"),
    pictures: count("picture"),
    wordsAdded: words((c) => c.newText),
    wordsRemoved: words((c) => c.oldText),
    pagesAdded: pairs.flatMap((p) => (p.a === null && p.b !== null ? [p.b] : [])),
    pagesRemoved: pairs.flatMap((p) => (p.b === null && p.a !== null ? [p.a] : [])),
  };
}

/** The text changes between two read documents, and their pages paired. */
export function compareWords(a: ReadDocument, b: ReadDocument, opts: { timeout?: number } = {}): CompareResult {
  const diff = diffWords(a.words, b.words, opts);
  const pairs = pairPages(diff.shared, a.pages.length, b.pages.length);
  return {
    changes: diff.changes,
    pairs,
    summary: summarise(diff.changes, pairs),
    scanned: { a: scannedPages(a), b: scannedPages(b) },
    coarse: diff.coarse,
  };
}

/** A pair of pages that look different where neither has words. */
export interface PictureChange {
  pair: number;
  areas: { a: AreaBox[]; b: AreaBox[] };
}

/**
 * Pictures that look different, put among the text changes in page order:
 * after the text changes of the pages before them.
 */
export function withPictures(result: CompareResult, pictures: PictureChange[], a: ReadDocument, b: ReadDocument): CompareResult {
  if (!pictures.length) return result;
  // The pair each change shows in: by its page in the changed version, else in the original.
  const pairOf = new Map<string, number>();
  result.pairs.forEach((p, n) => {
    if (p.b !== null) pairOf.set(`b${p.b}`, n);
    if (p.a !== null) pairOf.set(`a${p.a}`, n);
  });
  const where = (c: Change) => {
    const pb = c.newPage ?? pageAt(b.words, c.b);
    const pa = c.oldPage ?? pageAt(a.words, c.a);
    const inA = pa !== null ? pairOf.get(`a${pa}`) : undefined;
    const inB = pb !== null ? pairOf.get(`b${pb}`) : undefined;
    // A move stays where it was in the original, as in the list without pictures.
    return (c.kind === "moved" ? (inA ?? inB) : (inB ?? inA)) ?? 0;
  };
  const listed = result.changes.map((c, order) => ({ c, pair: where(c), order }));
  for (const pic of pictures) {
    const pair = result.pairs[pic.pair];
    listed.push({
      c: {
        kind: "picture",
        a: { start: 0, end: 0 },
        b: { start: 0, end: 0 },
        oldText: "",
        newText: "",
        oldPage: pair.a,
        newPage: pair.b,
        areas: pic.areas,
      },
      pair: pic.pair,
      // After the page's text changes.
      order: Infinity,
    });
  }
  listed.sort((x, y) => x.pair - y.pair || x.order - y.order);
  const changes = listed.map((l) => l.c);
  return { ...result, changes, summary: summarise(changes, result.pairs) };
}
