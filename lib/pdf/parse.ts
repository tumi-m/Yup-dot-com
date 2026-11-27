"use client";

/**
 * Layout-aware PDF parsing.
 *
 * Naive extraction concatenates pdf.js text items in stream order, which
 * scrambles multi-column pages and destroys tables. The 2026 generation of
 * parsers (Docling, Marker, MinerU) instead reconstruct a *document tree* —
 * reading order, heading hierarchy, paragraphs, lists, and table structure —
 * because that is what downstream LLM/RAG pipelines actually need.
 *
 * Those tools are GPU/Python vision models. This module implements the same
 * core idea using pure geometry: every text item from pdf.js carries a
 * position, size, and font, which is enough to rebuild structure entirely in
 * the browser. It is a deterministic heuristic parser, not a vision model —
 * it is very good on digital PDFs and does not attempt OCR on scans.
 */

import type { PDFPageProxy } from "pdfjs-dist";
import { configureWorker } from "./worker";
import { showsPictures } from "./page-content";
import { abortError } from "../abort";

export interface ParsedSpan {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  bold: boolean;
  /** A form field's value, drawn by the viewer rather than the page. */
  field?: boolean;
  /**
   * For text that doesn't run left to right as shown (sideways on a turned
   * page, upside down): where the run starts, from the page's top left, its
   * direction and its length, so a word in it can be found on the page.
   */
  run?: { x: number; y: number; dx: number; dy: number; length: number };
}

export interface ParsedLine {
  text: string;
  x: number;
  right: number;
  y: number;
  fontSize: number;
  bold: boolean;
  /** Reads right to left (Arabic, Hebrew): `spans` run from the right. */
  rtl: boolean;
  spans: ParsedSpan[];
  /** Which part of a two-column page the line is in: full-width rows, or a run of columns. */
  band?: number;
}

export type BlockType = "heading" | "paragraph" | "list" | "table";

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
  page: number;
}
export interface ParagraphBlock {
  type: "paragraph";
  text: string;
  page: number;
}
export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: string[];
  page: number;
}
export interface TableBlock {
  type: "table";
  rows: string[][];
  page: number;
}

export type Block = HeadingBlock | ParagraphBlock | ListBlock | TableBlock;

export interface ParsedDocument {
  blocks: Block[];
  pageCount: number;
  /** Median body font size, used for heading classification. */
  bodySize: number;
  /**
   * True when there is no text at all, or at least half the pages are
   * scans: a picture, with next to no text of their own.
   */
  likelyScanned: boolean;
  /** Pages that are a picture with next to no text of their own; listed only when asked for. */
  scans?: number[];
}

/** A page with fewer characters than this has no real text layer of its own. */
const PAGE_TEXT = 40;

// ---------------------------------------------------------------------------
// pdf.js loading
// ---------------------------------------------------------------------------

async function getPdfjs() {
  // The legacy build, for Safari before 17.4 and older iPhones (see worker.ts).
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  configureWorker(pdfjsLib);
  return pdfjsLib;
}

// ---------------------------------------------------------------------------
// Stage 1 — spans
// ---------------------------------------------------------------------------

interface RawItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
}

// Characters XML 1.0 forbids (C0 controls, U+FFFE/U+FFFF, lone surrogates).
// Broken font maps can produce them, and one is enough to corrupt a .docx.
const XML_ILLEGAL =
  /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Arabic and Hebrew letters in their joined shapes (U+FExx and the like), as
// many PDFs store them: made the plain letters again, so the text can be
// searched. Other compatibility characters (², ½, ™) stay as they are.
const PRESENTATION_FORMS = /[\uFB1D-\uFDFF\uFE70-\uFEFE]+/g;

// List bullets drawn from the Symbol and Wingdings fonts (Word and LibreOffice
// lists), which many PDFs map to private-use codes: made real bullets, so the
// list reads as one.
const SYMBOL_BULLETS = /[\uF0B7\uF0A7]/g;
const BULLET_FOR: Record<string, string> = { "\uF0B7": "•", "\uF0A7": "▪" };

/**
 * Spans on the page as displayed: from the CropBox's corner with /Rotate
 * applied, y up from the bottom. A landscape page stored as a portrait one
 * turned by /Rotate, or one cut from a wider sheet, reads like any other.
 */
function toSpans(items: RawItem[], viewport: { transform: number[]; height: number }): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const scale = Math.hypot(va, vb) || 1;
  for (const item of items) {
    const text = item.str
      ?.replace(PRESENTATION_FORMS, (forms) => forms.normalize("NFKC"))
      .replace(SYMBOL_BULLETS, (c) => BULLET_FOR[c])
      .replace(XML_ILLEGAL, "");
    if (!text || !text.trim()) continue;
    const [a, b, c, d, e, f] = item.transform;
    // The baseline's direction on the displayed page.
    const dx = va * a + vc * b;
    const dy = vb * a + vd * b;
    const size = Math.hypot(dx, dy);
    // The font size is the letters' height: their width is stretched or
    // squeezed by the text's horizontal scaling, as OCR text layers do to
    // fit each word over its picture.
    const tall = Math.hypot(va * c + vc * d, vb * c + vd * d);
    const fontSize = tall || size || item.height || 12;
    // The run's extent across the page; its width is measured along the baseline.
    const run = (size ? dx / size : 1) * item.width * scale;
    const x = va * e + vc * f + ve;
    const top = vb * e + vd * f + vf;
    const fontName = item.fontName ?? "";
    const sideways = size > 0 && dx / size < 0.999;
    spans.push({
      text,
      x: Math.min(x, x + run),
      y: viewport.height - top,
      width: Math.abs(run),
      height: item.height * scale || fontSize,
      fontSize,
      fontName,
      bold: /bold|black|heavy|semibold/i.test(fontName),
      ...(sideways ? { run: { x, y: top, dx: dx / size, dy: dy / size, length: item.width * scale } } : {}),
    });
  }
  return spans;
}

/** What pdf.js tells of a form field's widget. */
interface WidgetAnnotation {
  subtype?: string;
  hidden?: boolean;
  rect?: number[];
  fieldType?: string;
  fieldValue?: string | string[] | null;
  fieldFlags?: number;
  checkBox?: boolean;
  radioButton?: boolean;
  exportValue?: string;
  buttonValue?: string;
  defaultAppearanceData?: { fontSize?: number };
}

/** A text field that shows dots instead of what was typed. */
const PASSWORD_FIELD = 1 << 13;

/** What a filled-in field shows, or "" when there is nothing to read. */
function fieldText(a: WidgetAnnotation): string {
  const value = a.fieldValue;
  if (a.fieldType === "Tx") return a.fieldFlags && a.fieldFlags & PASSWORD_FIELD ? "" : typeof value === "string" ? value : "";
  if (a.fieldType === "Ch") return Array.isArray(value) ? value.join(", ") : value ?? "";
  if (a.fieldType === "Btn") {
    if (a.checkBox) return value && value !== "Off" && value === a.exportValue ? "☒" : "";
    if (a.radioButton) return value != null && a.buttonValue === value ? "◉" : "";
  }
  return "";
}

/**
 * Filled-in form values as spans where their fields sit, in the same
 * coordinates as toSpans. Their text is drawn by the viewer, not the page,
 * so the page's own text has a label ("Name:") but not what was typed.
 */
function fieldSpans(annotations: WidgetAnnotation[], viewport: { transform: number[]; height: number }): ParsedSpan[] {
  const [va, vb, vc, vd, ve, vf] = viewport.transform;
  const spans: ParsedSpan[] = [];
  for (const a of annotations) {
    if (a.subtype !== "Widget" || a.hidden || !a.rect || a.rect.length < 4) continue;
    const text = fieldText(a).replace(XML_ILLEGAL, "").trim();
    if (!text) continue;
    const [x1, y1, x2, y2] = a.rect;
    const xs = [va * x1 + vc * y1 + ve, va * x2 + vc * y2 + ve];
    const ys = [viewport.height - (vb * x1 + vd * y1 + vf), viewport.height - (vb * x2 + vd * y2 + vf)];
    const height = Math.abs(ys[1] - ys[0]);
    const auto = a.defaultAppearanceData?.fontSize;
    const fontSize = Math.min(14, auto && auto > 0 ? auto : 0.7 * height) || 10;
    spans.push({
      text,
      x: Math.min(...xs),
      // Where a one-line field draws its text: centred, on a baseline below the middle.
      y: Math.min(...ys) + Math.max(0, (height - fontSize * 0.7) / 2),
      width: Math.abs(xs[1] - xs[0]),
      height: fontSize,
      fontSize,
      fontName: "",
      bold: false,
      field: true,
    });
  }
  return spans;
}

const RTL_LETTERS = /(?=\p{L})[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/gu;
const LTR_LETTERS = /(?=\p{L})[^\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/gu;

/** Letters of right-to-left scripts less the others: positive for Arabic or Hebrew text. */
function rtlBalance(text: string): number {
  return (text.match(RTL_LETTERS)?.length ?? 0) - (text.match(LTR_LETTERS)?.length ?? 0);
}

/** True when most letters in `text` are Arabic, Hebrew or another right-to-left script. */
export function isRtl(text: string): boolean {
  return rtlBalance(text) > 0;
}

/** True when `text` has any letter of a right-to-left script. */
export function hasRtl(text: string): boolean {
  return text.search(RTL_LETTERS) >= 0;
}

/** Horizontal space between two spans, whichever side each is on. */
function gapBetween(p: ParsedSpan, q: ParsedSpan): number {
  return Math.max(p.x, q.x) - Math.min(p.x + p.width, q.x + q.width);
}

/**
 * Text of spans next to each other in reading direction, with a space where
 * they stand apart. pdf.js gives each piece in reading order, but pieces of
 * the other direction (an English name in Arabic text, a number, or Arabic
 * letters drawn one by one in an English line) come in visual order: those
 * runs are turned around.
 */
function joinSpans(spans: ParsedSpan[], rtl: boolean): string {
  const pieces: { text: string; flip: boolean; word: boolean }[] = [];
  spans.forEach((span, i) => {
    const prev = spans[i - 1];
    const last = pieces[pieces.length - 1]?.text ?? "";
    // A space when the gap exceeds a fraction of an em and the runs are not
    // already separated by their own whitespace.
    if (prev && gapBetween(prev, span) > prev.fontSize * 0.18 && !/\s$/.test(last) && !/^\s/.test(span.text)) {
      pieces.push({ text: " ", flip: false, word: false });
    }
    const balance = rtlBalance(span.text);
    const ltr = balance < 0 || (!balance && /\p{Nd}/u.test(span.text));
    pieces.push({ text: span.text, flip: rtl ? ltr : balance > 0, word: balance !== 0 || ltr });
  });
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i].flip) continue;
    // The run reaches the last piece of that direction before one of the line's own.
    let end = i;
    for (let k = i + 1; k < pieces.length && (pieces[k].flip || !pieces[k].word); k++) if (pieces[k].flip) end = k;
    pieces.splice(i, end - i + 1, ...pieces.slice(i, end + 1).reverse());
    i = end;
  }
  return pieces.map((p) => p.text).join("");
}

// ---------------------------------------------------------------------------
// Stage 2 — lines (cluster spans sharing a baseline)
// ---------------------------------------------------------------------------

/** Spans grouped by shared baseline, top to bottom, each row in the order found. */
function baselineRows(spans: ParsedSpan[]): ParsedSpan[][] {
  if (!spans.length) return [];
  // Top-to-bottom: PDF y grows upward, so sort descending.
  const sorted = [...spans].sort((p, q) => q.y - p.y || p.x - q.x);

  const lines: ParsedSpan[][] = [];
  let current: ParsedSpan[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const span = sorted[i];
    const ref = current[0];
    const tolerance = Math.max(2, ref.fontSize * 0.5);
    if (Math.abs(span.y - ref.y) <= tolerance) {
      current.push(span);
    } else {
      lines.push(current);
      current = [span];
    }
  }
  lines.push(current);
  return lines;
}

function toLines(spans: ParsedSpan[]): ParsedLine[] {
  if (!spans.length) return [];
  const lines = baselineRows(spans);

  // Lines of only numbers or signs read in the page's direction.
  const rtlPage = isRtl(spans.map((s) => s.text).join(""));
  return lines.map((group) => {
    const balance = rtlBalance(group.map((s) => s.text).join(""));
    const rtl = balance > 0 || (!balance && rtlPage);
    // Right-to-left lines (Arabic, Hebrew) read from the right.
    const ordered = [...group].sort((p, q) => (rtl ? q.x - p.x : p.x - q.x));
    // A field's value is drawn at whatever size its box allows: the label's size is the line's.
    const printed = ordered.filter((s) => !s.field);
    const fontSize = median((printed.length ? printed : ordered).map((s) => s.fontSize));
    return {
      text: joinSpans(ordered, rtl).replace(/\s+/g, " ").trim(),
      x: Math.min(...ordered.map((s) => s.x)),
      right: Math.max(...ordered.map((s) => s.x + s.width)),
      y: ordered[0].y,
      fontSize,
      bold: ordered.every((s) => s.bold),
      rtl,
      spans: ordered,
    };
  }).filter((l) => l.text.length > 0);
}

// ---------------------------------------------------------------------------
// Stage 3 — reading order (multi-column detection)
// ---------------------------------------------------------------------------

/** Spans wider than this share of the page are full-width text, not a column. */
const FULL_WIDTH = 0.55;
/** Column text is made of lines at least this share of the page wide; table cells are narrower. */
const MIN_COLUMN_TEXT = 0.18;

/**
 * Finds the x-coordinate of a vertical gutter separating two text columns.
 *
 * This must run on spans *before* line grouping: in a real two-column page the
 * left and right columns usually share baselines, so grouping first would fuse
 * them into single lines and destroy the evidence.
 *
 * Returns null for single-column pages.
 */
function detectGutter(allSpans: ParsedSpan[], pageWidth: number): number | null {
  if (pageWidth <= 0) return null;
  // A full-width abstract or paragraph says nothing about the columns below
  // it, and a few of its lines would otherwise fill the gutter.
  const spans = allSpans.filter((s) => s.width <= pageWidth * FULL_WIDTH);
  if (spans.length < 6) return null;

  const BIN = 4;
  const binCount = Math.ceil(pageWidth / BIN);
  const occupancy = new Array<number>(binCount).fill(0);

  for (const span of spans) {
    const from = Math.max(0, Math.floor(span.x / BIN));
    const to = Math.min(binCount - 1, Math.floor((span.x + span.width) / BIN));
    for (let i = from; i <= to; i++) occupancy[i]++;
  }

  // Tolerate a few crossing spans (a title over two columns).
  const tolerance = Math.max(1, Math.floor(spans.length * 0.06));
  const lo = Math.floor(binCount * 0.28);
  const hi = Math.ceil(binCount * 0.72);

  // Every empty run, longest first: the space after a sidebar's short lines
  // can be wider than the gutter itself, but has nothing to its right.
  const runs: { start: number; length: number }[] = [];
  let runStart = -1;
  for (let i = lo; i <= hi + 1; i++) {
    const empty = i <= hi && i < binCount && occupancy[i] <= tolerance;
    if (empty && runStart === -1) runStart = i;
    if (!empty && runStart !== -1) {
      runs.push({ start: runStart, length: i - runStart });
      runStart = -1;
    }
  }
  runs.sort((a, b) => b.length - a.length);

  const MIN_GUTTER_PT = 14;
  const best = runs.find((run) => {
    if (run.length * BIN < MIN_GUTTER_PT) return false;
    const gutter = (run.start + run.length / 2) * BIN;
    const left = spans.filter((s) => s.x + s.width <= gutter);
    const right = spans.filter((s) => s.x >= gutter);
    // Both sides must carry real content for the split to be meaningful.
    return left.length >= spans.length * 0.2 && right.length >= spans.length * 0.2;
  });
  if (!best) return null;
  const gutter = (best.start + best.length / 2) * BIN;
  // The space between two columns of a table looks like a gutter too:
  // linesInReadingOrder only splits runs of rows that are column text.
  return gutter;
}

/**
 * True when these spans are lines of running text, not table cells: without
 * this, a table would be torn apart at the space between two of its columns.
 */
function columnText(spans: ParsedSpan[], pageWidth: number): boolean {
  return spans.length > 0 && median(spans.map((s) => s.width)) >= pageWidth * MIN_COLUMN_TEXT;
}

/** Spans split wherever they stand more than `em` ems apart, left to right. */
function groupsOf(spans: ParsedSpan[], em: number): { x: number; right: number }[] {
  const groups: { x: number; right: number }[] = [];
  let prev: ParsedSpan | undefined;
  for (const span of [...spans].sort((p, q) => p.x - q.x)) {
    const last = groups[groups.length - 1];
    if (last && prev && span.x - last.right <= prev.fontSize * em) last.right = Math.max(last.right, span.x + span.width);
    else groups.push({ x: span.x, right: span.x + span.width });
    prev = span;
  }
  return groups;
}

/**
 * Orders spans into lines, reading the page top to bottom in bands: a run of
 * rows split by the gutter is read left column first, then right; a row
 * that runs across it (a title, an abstract, a figure caption, a footer)
 * is read where it stands. Short runs and table rows are read row by row,
 * so a table keeps all its columns.
 */
function linesInReadingOrder(spans: ParsedSpan[], pageWidth: number): ParsedLine[] {
  const gutter = detectGutter(spans, pageWidth);
  if (gutter === null) return toLines(spans);

  const isLeft = (s: ParsedSpan) => s.x + s.width <= gutter;
  const rowWidth = (row: ParsedSpan[]) => Math.max(...row.map((s) => s.x + s.width)) - Math.min(...row.map((s) => s.x));
  const across = (row: ParsedSpan[]) => {
    if (row.some((s) => s.x < gutter && s.x + s.width > gutter)) return true;
    // Words of one line that happen to break at the gutter stand a word space apart.
    const leftEdge = Math.max(...row.filter(isLeft).map((s) => s.x + s.width));
    const rightEdge = Math.min(...row.filter((s) => !isLeft(s)).map((s) => s.x));
    return rightEdge - leftEdge < Math.max(...row.map((s) => s.fontSize)) * CELL_GAP_EM;
  };
  // A table row: cells on both sides, none as wide as a line of column text.
  const cells = (row: ParsedSpan[]) => {
    const left = row.filter(isLeft);
    const right = row.filter((s) => !isLeft(s));
    return left.length > 0 && right.length > 0 &&
      [...groupsOf(left, 1), ...groupsOf(right, 1)].every((g) => g.right - g.x < pageWidth * MIN_COLUMN_TEXT);
  };

  const rows = baselineRows(spans);
  const kind = rows.map((row): "across" | "cells" | "split" => (across(row) ? "across" : cells(row) ? "cells" : "split"));
  // One such row is two short lines side by side, such as the ends of two paragraphs.
  kind.forEach((k, i) => {
    if (k === "cells" && kind[i - 1] !== "cells" && kind[i + 1] !== "cells") kind[i] = "split";
  });

  const out: ParsedLine[] = [];
  let bands = 0;
  const emit = (lines: ParsedLine[]) => {
    if (!lines.length) return;
    for (const line of lines) line.band = bands;
    out.push(...lines);
    bands++;
  };
  let full: ParsedSpan[] = [];
  let i = 0;
  while (i < rows.length) {
    if (kind[i] !== "split") {
      full.push(...rows[i++]);
      continue;
    }
    let end = i;
    while (end < rows.length && kind[end] === "split") end++;
    let band = rows.slice(i, end);
    // A heading or a line or two under the shorter column that lead into a
    // table or full-width text below belong with what follows them.
    const next = rows[end];
    if (next && (kind[end] === "cells" || rowWidth(next) >= pageWidth * MIN_COLUMN_TEXT)) {
      const lastLeft = band.findLastIndex((row) => row.some(isLeft));
      const lastRight = band.findLastIndex((row) => row.some((s) => !isLeft(s)));
      const tail = band.length - 1 - Math.min(lastLeft, lastRight);
      if (tail > 0 && tail <= 3) {
        end -= tail;
        band = band.slice(0, -tail);
      }
    }
    const left = band.flat().filter(isLeft);
    const right = band.flat().filter((s) => !isLeft(s));
    // A sidebar of headings and short items beside a column of text is read
    // after it too: its lines seldom share a baseline with the column's, as
    // a table's cells do.
    const both = band.filter((row) => row.some(isLeft) && row.some((s) => !isLeft(s))).length;
    const sidebar = (columnText(left, pageWidth) || columnText(right, pageWidth)) && both * 3 <= band.length;
    if (band.length >= 3 && left.length && right.length && ((columnText(left, pageWidth) && columnText(right, pageWidth)) || sidebar)) {
      emit(toLines(full));
      emit([...toLines(left), ...toLines(right)]);
      full = [];
    } else {
      full.push(...band.flat());
    }
    i = end;
    // The tail, if any, joins the rows that follow.
    while (i < rows.length && kind[i] === "split") full.push(...rows[i++]);
  }
  emit(toLines(full));
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4 — table detection
// ---------------------------------------------------------------------------

interface Cell {
  text: string;
  x: number;
  right: number;
}

/**
 * A gap wider than this (in ems) separates cells. Word spaces are ~0.25em;
 * tightly padded tables (HTML/Word exports) leave well under 1em between
 * columns, so a larger threshold fuses neighbouring cells.
 */
const CELL_GAP_EM = 0.6;

/**
 * Split a line into cells wherever an unusually wide horizontal gap appears.
 * Cells come in reading order: from the right in a right-to-left line.
 */
function splitCells(line: ParsedLine): Cell[] {
  const groups: ParsedSpan[][] = [];
  line.spans.forEach((span, i) => {
    const prev = line.spans[i - 1];
    // A form field's value stays with its label ("Name:", a tick box's caption), not a cell of its own;
    // a list's bullet stays with its item.
    const bullet = i === 1 && /^[•▪◦‣]$/.test(prev.text.trim());
    if (!prev || (gapBetween(prev, span) > prev.fontSize * CELL_GAP_EM && !prev.field && !span.field && !bullet)) groups.push([]);
    groups[groups.length - 1].push(span);
  });
  return groups.map((spans) => ({
    text: joinSpans(spans, line.rtl).trim(),
    x: Math.min(...spans.map((s) => s.x)),
    right: Math.max(...spans.map((s) => s.x + s.width)),
  }));
}

/**
 * Groups consecutive lines whose cells line up into a table. Cells align when
 * their horizontal extents overlap, which also matches centred headers over
 * left- or right-aligned values. Returns index ranges to treat as tables.
 */
function findTables(lines: ParsedLine[]): { start: number; end: number; rows: string[][] }[] {
  const cellRows = lines.map(splitCells);
  const tables: { start: number; end: number; rows: string[][] }[] = [];
  let i = 0;

  const overlaps = (c: Cell, anchor: Cell[], slack: number) =>
    anchor.some((a) => c.x <= a.right + slack && c.right >= a.x - slack);

  while (i < lines.length) {
    if (cellRows[i].length < 2) {
      i++;
      continue;
    }
    // Extend while subsequent rows have a comparable number of aligned columns.
    let j = i + 1;
    const anchor = cellRows[i];
    while (j < lines.length && cellRows[j].length >= 2) {
      const slack = Math.max(2, lines[j].fontSize * 0.25);
      const aligned = cellRows[j].filter((c) => overlaps(c, anchor, slack)).length;
      // Each anchor column may only be claimed once, or one wide cell could
      // "align" with everything.
      const claimed = anchor.filter((a) => cellRows[j].some((c) => overlaps(c, [a], slack))).length;
      if (Math.min(aligned, claimed) < Math.min(2, cellRows[j].length)) break;
      j++;
    }
    // Require at least two rows to call it a table.
    if (j - i >= 2) {
      const rows = cellRows.slice(i, j).map((r) => r.map((c) => c.text));
      const width = Math.max(...rows.map((r) => r.length));
      tables.push({
        start: i,
        end: j,
        rows: rows.map((r) => [...r, ...Array(width - r.length).fill("")]),
      });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Stage 5 — block assembly
// ---------------------------------------------------------------------------

const BULLET = /^\s*[•·▪◦‣\-–—*]\s+/;
const ORDERED = /^\s*(\d{1,2}|[a-z])[.)]\s+/i;
const SENTENCE_END = /[.!?]["'”’)\]]?$/;
/** A page's number on its own: "7", "- 7 -", "Page 7 of 12", "vii". */
const PAGE_NUMBER = /^(?:page\s+)?[-–—]?\s*(?:\d{1,4}|[ivxlc]{1,7})\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

/**
 * Lines of one paragraph as running text. A word broken at a line end
 * ("inter-" / "national") is made whole; a hyphen before a capital or a
 * digit ("Anglo-" / "Saxon", "COVID-" / "19") is part of the word and stays.
 */
function joinLines(texts: string[]): string {
  let out = "";
  for (const text of texts) {
    if (!out) out = text;
    else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(text)) out = out.slice(0, -1) + text;
    else out += " " + text;
  }
  return out.trim();
}

function classifyHeading(line: ParsedLine, bodySize: number): number | null {
  // A form field's value is never a heading, however large its box.
  if (line.spans.every((s) => s.field)) return null;
  const ratio = line.fontSize / bodySize;
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.45) return 2;
  if (ratio >= 1.18) return 3;
  // Short, bold, non-terminated lines read as headings even at body size.
  if (line.bold && ratio >= 1.02 && line.text.length < 90 && !/[.:;,]$/.test(line.text)) {
    return 4;
  }
  return null;
}

function buildBlocks(
  lines: ParsedLine[],
  bodySize: number,
  page: number
): Block[] {
  const blocks: Block[] = [];
  const tables = findTables(lines);
  const inTable = new Map<number, (typeof tables)[number]>();
  for (const t of tables) {
    for (let k = t.start; k < t.end; k++) inTable.set(k, t);
  }

  let paragraph: string[] = [];
  // The widest line of the paragraph so far: its column's width.
  let widest = 0;
  let listItems: string[] = [];
  let listOrdered = false;
  // Where the current list item's words start, after its marker.
  let itemText: number | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: joinLines(paragraph), page });
      paragraph = [];
      widest = 0;
    }
  };
  const flushList = () => {
    if (listItems.length) {
      blocks.push({ type: "list", ordered: listOrdered, items: listItems, page });
      listItems = [];
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const table = inTable.get(i);
    if (table) {
      if (table.start === i) {
        flushAll();
        blocks.push({ type: "table", rows: table.rows, page });
      }
      continue;
    }

    const line = lines[i];
    const heading = classifyHeading(line, bodySize);

    if (heading) {
      flushAll();
      blocks.push({ type: "heading", level: heading, text: line.text, page });
      continue;
    }

    if (BULLET.test(line.text) || ORDERED.test(line.text)) {
      flushParagraph();
      const ordered = ORDERED.test(line.text) && !BULLET.test(line.text);
      if (listItems.length && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems.push(line.text.replace(BULLET, "").replace(ORDERED, "").trim());
      // Where the item's words start when the marker stands apart: its
      // wrapped lines start there too (a hanging indent).
      const marker = !line.rtl && line.spans.length > 1 && /^(?:[•·▪◦‣\-–—*]|\d{1,2}[.)]|[a-z][.)])$/i.test(line.spans[0].text.trim());
      itemText = marker ? line.spans[1].x : null;
      continue;
    }

    // A continuation line of the current list item (indented, no marker).
    if (listItems.length) {
      const prev = lines[i - 1];
      const aligned = prev && (Math.abs(line.x - prev.x) < 4 || (itemText !== null && Math.abs(line.x - itemText) < 4));
      if (aligned && line.x > lines[0].x + 4) {
        listItems[listItems.length - 1] = joinLines([listItems[listItems.length - 1], line.text]);
        continue;
      }
      flushList();
    }

    paragraph.push(line.text);
    const width = line.right - line.x;
    widest = Math.max(widest, width);

    // Break the paragraph when the next line is far below or clearly
    // indented, or when this one ends a sentence well short of the column's
    // width or where full-width text gives way to columns. The width is the
    // paragraph's own lines and the next one, never the page's: on a
    // two-column page the columns follow one another.
    const next = lines[i + 1];
    if (!next) {
      flushParagraph();
    } else {
      const gap = line.y - next.y;
      const endsSentence = SENTENCE_END.test(line.text);
      const short = width < Math.max(widest, next.right - next.x) * 0.8;
      if (gap > line.fontSize * 1.8 || (endsSentence && (next.x > line.x + 8 || short || next.band !== line.band))) {
        flushParagraph();
      }
    }
  }

  flushAll();
  return blocks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (!values.length) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One page's text as the parser reads it, and the page as displayed. */
export interface PageText {
  /** Lines in reading order, each with its spans and where they sit. */
  lines: ParsedLine[];
  /** Characters of the page's own text; filled-in form values aren't counted. */
  chars: number;
  /** The page as displayed (CropBox, /Rotate applied), in points. */
  width: number;
  height: number;
  /** pdf.js's viewport transform at scale 1: PDF user space to displayed points from the top left. */
  transform: number[];
  /** Shows a picture big enough to hold words; only looked for by callers that need it. */
  pictures?: boolean;
}

/** Reads one pdf.js page: its own text and filled-in form values, in reading order. */
export async function readPageText(page: PDFPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const spans = toSpans(content.items as unknown as RawItem[], viewport);
  const chars = spans.reduce((n, s) => n + s.text.trim().length, 0);
  try {
    // Before the gutter is found, so the values land in reading order.
    spans.push(...fieldSpans((await page.getAnnotations({ intent: "display" })) as WidgetAnnotation[], viewport));
  } catch {
    // Damaged annotations: the page's own text is still there.
  }
  return {
    lines: linesInReadingOrder(spans, viewport.width),
    chars,
    width: viewport.width,
    height: viewport.height,
    transform: [...viewport.transform],
  };
}

/** Parse a PDF into a structured document tree. */
export async function parseDocument(
  data: Uint8Array,
  onProgress?: (page: number, total: number) => void,
  /** Stops between pages once aborted. */
  signal?: AbortSignal,
  /** `scans`: look at every page with next to no text, and list those that are pictures. */
  options: { scans?: boolean } = {}
): Promise<ParsedDocument> {
  const pdfjsLib = await getPdfjs();
  const doc = await pdfjsLib.getDocument({ data: data.slice(), isEvalSupported: false }).promise;

  const perPage: { lines: ParsedLine[]; page: number }[] = [];
  const allSizes: number[] = [];
  let totalChars = 0;
  let scannedPages = 0;
  const scans: number[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    if (signal?.aborted) {
      doc.destroy();
      throw abortError();
    }
    const page = await doc.getPage(p);
    const { lines, chars } = await readPageText(page);
    totalChars += chars;
    // A scanned page: next to no text of its own, and a picture. A slide or
    // certificate with a short title has no picture, or more text. Pictures
    // are only looked for while the answer can still change.
    const undecided = scannedPages < doc.numPages / 2 && scannedPages + doc.numPages - p + 1 >= doc.numPages / 2;
    if (chars < PAGE_TEXT && (undecided || options.scans)) {
      try {
        if (await showsPictures(page, pdfjsLib.OPS as unknown as Record<string, number>)) {
          scannedPages++;
          scans.push(p);
        }
      } catch {
        // Drawing it fails: its text is all there is to go on.
      } finally {
        page.cleanup();
      }
    }
    perPage.push({ lines, page: p });

    for (const line of lines) {
      // Weight by character count so body text dominates the median.
      for (let k = 0; k < Math.max(1, Math.round(line.text.length / 10)); k++) {
        allSizes.push(line.fontSize);
      }
    }
    onProgress?.(p, doc.numPages);
  }

  const bodySize = median(allSizes);
  const blocks: Block[] = [];
  for (const { lines, page } of perPage) {
    const pageBlocks = buildBlocks(lines, bodySize, page);
    // A sentence that runs on over the page break is one paragraph, kept on
    // the page it starts on. Page numbers between the two halves stay where they are.
    const isNumber = (b: Block | undefined) => b?.type === "paragraph" && PAGE_NUMBER.test(b.text);
    let last = blocks.length - 1;
    while (last >= 0 && blocks[last].page === page - 1 && isNumber(blocks[last])) last--;
    const end = blocks[last];
    const first = pageBlocks.findIndex((b) => !isNumber(b));
    const start = pageBlocks[first];
    if (
      end?.type === "paragraph" && end.page === page - 1 && !SENTENCE_END.test(end.text) &&
      start?.type === "paragraph" && /^\p{Ll}/u.test(start.text)
    ) {
      end.text = joinLines([end.text, start.text]);
      pageBlocks.splice(first, 1);
    }
    blocks.push(...pageBlocks);
  }

  const pageCount = doc.numPages;
  doc.destroy();

  return {
    blocks,
    pageCount,
    bodySize,
    likelyScanned: totalChars === 0 || scannedPages >= pageCount / 2,
    ...(options.scans ? { scans } : {}),
  };
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export function toMarkdown(doc: ParsedDocument): string {
  const out: string[] = [];
  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(Math.min(6, block.level))} ${block.text}`);
        break;
      case "paragraph":
        out.push(block.text);
        break;
      case "list":
        out.push(
          block.items
            .map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`))
            .join("\n")
        );
        break;
      case "table": {
        const [header, ...rest] = block.rows;
        if (!header) break;
        const lines = [
          `| ${header.map(escapeCell).join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
          ...rest.map((r) => `| ${r.map(escapeCell).join(" | ")} |`),
        ];
        out.push(lines.join("\n"));
        break;
      }
    }
  }
  return out.join("\n\n") + "\n";
}

/** Plain text in correct reading order. */
export function toPlainText(doc: ParsedDocument): string {
  const out: string[] = [];
  for (const block of doc.blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      out.push(block.text);
    } else if (block.type === "list") {
      out.push(block.items.map((i) => `• ${i}`).join("\n"));
    } else if (block.type === "table") {
      out.push(block.rows.map((r) => r.join("\t")).join("\n"));
    }
  }
  return out.join("\n\n") + "\n";
}

/**
 * Text repeated at the top or foot of the pages: short paragraphs that appear
 * on more than one page once their numbers are set aside ("Page 3", a report's title).
 */
function runningText(blocks: Block[]): (block: Block) => boolean {
  const key = (text: string) => text.replace(/\d+/g, "#").trim().toLowerCase();
  const pages = new Map<string, Set<number>>();
  for (const b of blocks) {
    if (b.type !== "paragraph" || b.text.length > 80) continue;
    const seen = pages.get(key(b.text)) ?? new Set<number>();
    seen.add(b.page);
    pages.set(key(b.text), seen);
  }
  return (b) =>
    b.type === "paragraph" && b.text.length <= 80 && (PAGE_NUMBER.test(b.text) || (pages.get(key(b.text))?.size ?? 0) > 1);
}

/**
 * The document's tables. One that runs on over a page break is one table:
 * a table that opens a page continues the one that closed the page before
 * when they have as many columns, and a header repeated on the new page is
 * dropped. It keeps the page it starts on.
 */
export function extractTables(doc: ParsedDocument): TableBlock[] {
  const running = runningText(doc.blocks);
  const tables: TableBlock[] = [];
  let prev: Block | undefined;
  // The page the last table's latest part is on.
  let reaches = 0;
  for (const block of doc.blocks) {
    if (running(block)) continue;
    if (block.type === "table") {
      const last = tables[tables.length - 1];
      const width = (t: TableBlock) => t.rows[0]?.length ?? 0;
      if (prev?.type === "table" && last && reaches === block.page - 1 && width(last) === width(block)) {
        const repeated = block.rows[0]?.join("\u0000") === last.rows[0]?.join("\u0000");
        last.rows.push(...(repeated ? block.rows.slice(1) : block.rows));
      } else {
        tables.push({ ...block, rows: [...block.rows] });
      }
      reaches = block.page;
    }
    prev = block;
  }
  return tables;
}

function csvCell(cell: string): string {
  // Spreadsheets run cells starting with = + - @ as formulas. Plain negative
  // numbers (and a lone "-") are safe and stay as they are.
  const safe = /^[=+\-@\t\r]/.test(cell) && !/^-([\d.,]+%?)?$/.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 CSV with a byte-order mark, so Excel shows accented text correctly. */
export function tableToCsv(table: TableBlock): string {
  return "\uFEFF" + table.rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export interface Chunk {
  /** Heading breadcrumb, e.g. "Report > Q3 > Revenue". */
  path: string;
  text: string;
  page: number;
}

/**
 * Splits text longer than `max` into pieces that fit, breaking at the last
 * line break (table row, list item), sentence end or space that fits.
 */
function splitToFit(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    const min = max / 2; // a break this early would leave a tiny piece
    let cut = head.lastIndexOf("\n");
    if (cut < min) {
      cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! ")) + 1;
    }
    if (cut < min) cut = head.lastIndexOf(" ");
    if (cut < 1) {
      cut = Math.max(1, max);
      // Don't split a surrogate pair.
      if (cut > 1 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Split into retrieval-sized chunks that carry their heading path, so each
 * chunk stays semantically self-contained for RAG.
 */
export function toChunks(doc: ParsedDocument, maxChars = 1200): Chunk[] {
  const chunks: Chunk[] = [];
  const headings: string[] = [];
  let buffer = "";
  let bufferPage = 1;

  const flush = () => {
    if (buffer.trim()) {
      chunks.push({
        // Skip unset levels, e.g. when the first heading is an h3.
        path: headings.filter(Boolean).join(" > "),
        text: buffer.trim(),
        page: bufferPage,
      });
    }
    buffer = "";
  };

  for (const block of doc.blocks) {
    if (block.type === "heading") {
      flush();
      headings.length = Math.max(0, Math.min(headings.length, block.level - 1));
      headings[block.level - 1] = block.text;
      headings.length = block.level;
      bufferPage = block.page;
      continue;
    }

    let text = "";
    if (block.type === "paragraph") text = block.text;
    else if (block.type === "list") text = block.items.map((i) => `• ${i}`).join("\n");
    else if (block.type === "table") text = block.rows.map((r) => r.join(" | ")).join("\n");

    if (!text) continue;
    for (const piece of splitToFit(text, maxChars)) {
      if (buffer && buffer.length + 2 + piece.length > maxChars) {
        flush();
        bufferPage = block.page;
      }
      buffer += (buffer ? "\n\n" : "") + piece;
    }
  }
  flush();
  return chunks;
}

/**
 * Reading-order text with [Page N] markers, so an assistant can cite pages.
 * Tables are rendered as pipe-separated rows to keep their structure legible.
 */
export function toPagedText(doc: ParsedDocument): string {
  const pages = new Map<number, string[]>();
  for (const block of doc.blocks) {
    const out = pages.get(block.page) ?? [];
    if (block.type === "heading") out.push(`${"#".repeat(Math.min(6, block.level))} ${block.text}`);
    else if (block.type === "paragraph") out.push(block.text);
    else if (block.type === "list") out.push(block.items.map((i) => `- ${i}`).join("\n"));
    else out.push(block.rows.map((r) => r.join(" | ")).join("\n"));
    pages.set(block.page, out);
  }
  return [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, parts]) => `[Page ${page}]\n${parts.join("\n\n")}`)
    .join("\n\n");
}
