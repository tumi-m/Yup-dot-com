/**
 * The words two PDFs are compared by, read from the parser's lines (see
 * readPageText in ../parse): each with the page it is on and its box there,
 * so a change can be shown where it is printed. Plain data in and out, so it
 * runs in a worker and in Node tests.
 */
import type { PageText, ParsedLine } from "../parse";

/** In displayed points from the page's top left (CropBox, /Rotate applied). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Word {
  /** As printed; a word broken over a line end is put back together. */
  text: string;
  /** What is compared: ligatures, odd spaces and hyphens evened out. */
  key: string;
  /** 0-indexed. */
  page: number;
  /** The line it is on, counted through the document: words on one line share a mark. */
  line: number;
  /** One box, or two for a word broken over a line end. */
  boxes: Box[];
  /** Put back together from a word broken over a line end. */
  joined?: boolean;
  /** Printed right after the word before it, with no space ("days'", "(see"). */
  glued?: boolean;
}

export interface PageInfo {
  width: number;
  height: number;
  /** PDF user space to displayed points (pdf.js's viewport transform at scale 1). */
  transform: number[];
  /** Characters of the page's own text: next to none means a scan or a drawing. */
  chars: number;
  /** Shows a picture big enough to hold words (only looked for when there is next to no text). */
  pictures?: boolean;
  /** The first of the page's words and one past its last, in the document's words. */
  from: number;
  to: number;
}

export interface ReadDocument {
  words: Word[];
  pages: PageInfo[];
}

/** A page with fewer characters than this has no real text of its own (as the parser counts). */
export const PAGE_TEXT = 40;

// Soft hyphens and joiners print as nothing (a soft hyphen at a line end is
// read as a hyphen below); NFKC turns ligatures (ﬁ, ﬄ) and odd spaces into
// plain letters and spaces.
const INVISIBLE = /[​-‍⁠﻿]/g;

/** A piece of text as it is compared. */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/­/g, "-")
    .replace(/[‐‑]/g, "-")
    .replace(/\s+/g, " ");
}

// A word: letters and digits, with an apostrophe, hyphen, dot or comma inside
// it ("don't", "well-known", "3.14", "1,000"). Any other sign is a word of its own.
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:['’.,-][\p{L}\p{N}\p{M}]+)*|\S/gu;
const LOWER_START = /^\p{Ll}/u;
const WORDLIKE = /^[\p{L}\p{N}]/u;
const WORDLIKE_ANY = /[\p{L}\p{N}]/u;

/**
 * How wide a letter usually is, in ems, in a typical sans or serif face:
 * enough to put a highlight on the right word of a line without the font's
 * own widths.
 */
function letterWidth(ch: string): number {
  if (/\s/.test(ch)) return 0.28;
  if (/[iljI.,:;'!|`]/.test(ch)) return 0.26;
  if (/[ftr()\[\]{}"\-]/.test(ch)) return 0.34;
  if (/[mwMW@%]/.test(ch)) return 0.86;
  if (/[A-Z&]/.test(ch)) return 0.68;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) return 1;
  return 0.54;
}

interface Piece {
  text: string;
  key: string;
  box: Box;
  /** There is a space between this and the piece before it. */
  spaced: boolean;
}

/** A line's pieces, each with its box: a span's width is shared among its letters. */
function linePieces(line: ParsedLine, pageHeight: number): Piece[] {
  const chars: string[] = [];
  const boxes: { x0: number; x1: number; top: number; bottom: number }[] = [];
  const push = (ch: string, x0: number, x1: number, top: number, bottom: number) => {
    // NFKC can make one letter two (ﬁ is f and i): both get its box.
    for (const unit of normalise(ch)) {
      for (let k = 0; k < unit.length; k++) {
        chars.push(unit[k]);
        boxes.push({ x0, x1, top, bottom });
      }
    }
  };
  line.spans.forEach((span, i) => {
    const prev = line.spans[i - 1];
    // A space where the parser puts one (see joinSpans in ../parse).
    if (prev && chars.length && !/\s$/.test(chars[chars.length - 1]) && !/^\s/.test(span.text)) {
      // Along the run for sideways text, across the page otherwise.
      const gap =
        prev.run && span.run
          ? (span.run.x - prev.run.x) * prev.run.dx + (span.run.y - prev.run.y) * prev.run.dy - prev.run.length
          : Math.max(prev.x, span.x) - Math.min(prev.x + prev.width, span.x + span.width);
      if (gap > prev.fontSize * 0.18) push(" ", 0, 0, 0, 0);
    }
    const letters = Array.from(span.text);
    const baseline = pageHeight - span.y;
    // From a fifth of the type size below the baseline to four fifths above it.
    const top = baseline - span.fontSize * 0.8;
    const bottom = baseline + span.fontSize * 0.2;
    // The span's length shared by how wide each letter usually is.
    const weights = letters.map(letterWidth);
    const length = span.run ? span.run.length : span.width;
    const unit = length / Math.max(1e-6, weights.reduce((x, y) => x + y, 0));
    let at = 0;
    letters.forEach((ch, k) => {
      const w = weights[k] * unit;
      if (span.run) {
        // Sideways or upside down: the letter's box along the run's direction.
        const { x, y, dx, dy } = span.run;
        const size = span.fontSize;
        // "Up" from the baseline, as shown: the run's direction turned a quarter.
        const corners = [at, at + w].flatMap((s) => [-0.2, 0.8].map((t) => [x + dx * s + dy * t * size, y + dy * s - dx * t * size]));
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        at += w;
        push(ch, Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
        return;
      }
      // A right-to-left span's letters run from its right edge.
      const x0 = line.rtl ? span.x + span.width - at - w : span.x + at;
      at += w;
      push(ch, x0, x0 + w, top, bottom);
    });
  });
  const text = chars.join("");
  const out: Piece[] = [];
  let end = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index!;
    const own = boxes.slice(at, at + m[0].length);
    const x0 = Math.min(...own.map((b) => b.x0));
    const x1 = Math.max(...own.map((b) => b.x1));
    const top = Math.min(...own.map((b) => b.top));
    const bottom = Math.max(...own.map((b) => b.bottom));
    out.push({
      text: m[0],
      key: m[0],
      box: { x: x0, y: top, width: Math.max(0, x1 - x0), height: Math.max(0, bottom - top) },
      spaced: at > end || !out.length,
    });
    end = at + m[0].length;
  }
  return out;
}

/** The two boxes as one, for a word and the hyphen after it. */
function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * Every word of a document in reading order, page after page. A word broken
 * by a hyphen at the end of a line ("infor-" then "mation") is one word, so
 * text that wraps differently in the other file still matches.
 */
export function readWords(pages: PageText[]): ReadDocument {
  const words: Word[] = [];
  const infos: PageInfo[] = [];
  let lineNo = 0;
  /** The last line's broken word, waiting for the start of the next line. */
  let broken: { word: Word; hyphen: Box } | null = null;
  const flush = () => {
    if (broken) words.push({ text: "-", key: "-", page: broken.word.page, line: broken.word.line, boxes: [broken.hyphen] });
    broken = null;
  };
  pages.forEach((page, p) => {
    // A word isn't put back together over a page break: its two boxes would be on two pages.
    flush();
    const from = words.length;
    for (const line of page.lines) {
      const pieces = linePieces(line, page.height);
      if (!pieces.length) continue;
      let start = 0;
      const first = pieces[0];
      if (broken && LOWER_START.test(first.text)) {
        // The rest of the broken word: it joins the word on the line before.
        const word = broken.word;
        word.text += first.text;
        word.key += first.key;
        word.boxes = [union(word.boxes[0], broken.hyphen), first.box];
        word.joined = true;
        broken = null;
        start = 1;
      }
      // Not a broken word after all ("well-" then "Known"): the hyphen counts.
      flush();
      const end = pieces.length;
      for (let i = start; i < end; i++) {
        const piece = pieces[i];
        const last = i === end - 1;
        // "infor-" at the end of the line: the hyphen waits to see what the next line starts with.
        if (last && piece.text === "-" && !piece.spaced && i > start && WORDLIKE.test(pieces[i - 1].text)) {
          broken = { word: words[words.length - 1], hyphen: piece.box };
          continue;
        }
        words.push({ text: piece.text, key: piece.key, page: p, line: lineNo, boxes: [piece.box], ...(piece.spaced ? {} : { glued: true }) });
      }
      lineNo++;
    }
    flush();
    infos.push({ width: page.width, height: page.height, transform: page.transform, chars: page.chars, ...(page.pictures ? { pictures: true } : {}), from, to: words.length });
  });
  return { words, pages: infos };
}

/** True when the two words read the same. A word put back together matches its hyphenated spelling too. */
export function sameWord(a: Word, b: Word): boolean {
  if (a.key === b.key) return true;
  return (!!a.joined || !!b.joined) && a.key.replace(/-/g, "") === b.key.replace(/-/g, "");
}

/** Words as they were printed: a space where the page had one, so "days' notice" isn't "days ' notice". */
export function joinWords(words: Word[]): string {
  let out = "";
  for (const w of words) {
    if (out && !w.glued) out += " ";
    out += w.text;
  }
  return out;
}

/** How many words a piece of listed text has; signs on their own don't count. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((t) => WORDLIKE_ANY.test(t)).length;
}
