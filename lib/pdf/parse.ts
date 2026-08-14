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

import { configureWorker } from "./worker";

export interface ParsedSpan {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontName: string;
  bold: boolean;
}

export interface ParsedLine {
  text: string;
  x: number;
  right: number;
  y: number;
  fontSize: number;
  bold: boolean;
  spans: ParsedSpan[];
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
  /** True when pages carried essentially no extractable text (likely a scan). */
  likelyScanned: boolean;
}

// ---------------------------------------------------------------------------
// pdf.js loading
// ---------------------------------------------------------------------------

async function getPdfjs() {
  const pdfjsLib = await import("pdfjs-dist");
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

function toSpans(items: RawItem[]): ParsedSpan[] {
  const spans: ParsedSpan[] = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const [a, b, , , e, f] = item.transform;
    // For unrotated text a == d == fontSize; hypot covers rotated runs.
    const fontSize = Math.hypot(a, b) || item.height || 12;
    const fontName = item.fontName ?? "";
    spans.push({
      text: item.str,
      x: e,
      y: f,
      width: item.width,
      height: item.height || fontSize,
      fontSize,
      fontName,
      bold: /bold|black|heavy|semibold/i.test(fontName),
    });
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Stage 2 — lines (cluster spans sharing a baseline)
// ---------------------------------------------------------------------------

function toLines(spans: ParsedSpan[]): ParsedLine[] {
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

  return lines.map((group) => {
    const ordered = [...group].sort((p, q) => p.x - q.x);
    let text = "";
    for (let i = 0; i < ordered.length; i++) {
      const span = ordered[i];
      if (i > 0) {
        const prev = ordered[i - 1];
        const gap = span.x - (prev.x + prev.width);
        // Insert a space when the visual gap exceeds a fraction of an em and
        // the runs are not already separated by their own whitespace.
        if (gap > prev.fontSize * 0.18 && !/\s$/.test(text) && !/^\s/.test(span.text)) {
          text += " ";
        }
      }
      text += span.text;
    }
    const fontSize = median(ordered.map((s) => s.fontSize));
    const last = ordered[ordered.length - 1];
    return {
      text: text.replace(/\s+/g, " ").trim(),
      x: ordered[0].x,
      right: last.x + last.width,
      y: ordered[0].y,
      fontSize,
      bold: ordered.every((s) => s.bold),
      spans: ordered,
    };
  }).filter((l) => l.text.length > 0);
}

// ---------------------------------------------------------------------------
// Stage 3 — reading order (multi-column detection)
// ---------------------------------------------------------------------------

/**
 * Finds the x-coordinate of a vertical gutter separating two text columns.
 *
 * This must run on spans *before* line grouping: in a real two-column page the
 * left and right columns usually share baselines, so grouping first would fuse
 * them into single lines and destroy the evidence.
 *
 * Returns null for single-column pages.
 */
function detectGutter(spans: ParsedSpan[], pageWidth: number): number | null {
  if (spans.length < 6 || pageWidth <= 0) return null;

  const BIN = 4;
  const binCount = Math.ceil(pageWidth / BIN);
  const occupancy = new Array<number>(binCount).fill(0);

  for (const span of spans) {
    const from = Math.max(0, Math.floor(span.x / BIN));
    const to = Math.min(binCount - 1, Math.floor((span.x + span.width) / BIN));
    for (let i = from; i <= to; i++) occupancy[i]++;
  }

  // Tolerate a few crossing spans (a full-width title over two columns).
  const tolerance = Math.max(1, Math.floor(spans.length * 0.06));
  const lo = Math.floor(binCount * 0.28);
  const hi = Math.ceil(binCount * 0.72);

  let best = { start: -1, length: 0 };
  let runStart = -1;
  for (let i = lo; i <= hi && i < binCount; i++) {
    if (occupancy[i] <= tolerance) {
      if (runStart === -1) runStart = i;
      const length = i - runStart + 1;
      if (length > best.length) best = { start: runStart, length };
    } else {
      runStart = -1;
    }
  }

  const MIN_GUTTER_PT = 14;
  if (best.length * BIN < MIN_GUTTER_PT) return null;

  const gutter = (best.start + best.length / 2) * BIN;
  const left = spans.filter((s) => s.x + s.width <= gutter).length;
  const right = spans.filter((s) => s.x >= gutter).length;
  // Both sides must carry real content for the split to be meaningful.
  if (left < spans.length * 0.2 || right < spans.length * 0.2) return null;
  return gutter;
}

/**
 * Orders spans into lines, splitting on a detected column gutter so the left
 * column is read completely before the right.
 *
 * Full-width spans (a title crossing the gutter) are emitted first, which is
 * correct for the common case of a banner heading above the columns.
 */
function linesInReadingOrder(spans: ParsedSpan[], pageWidth: number): ParsedLine[] {
  const gutter = detectGutter(spans, pageWidth);
  if (gutter === null) return toLines(spans);

  const full: ParsedSpan[] = [];
  const left: ParsedSpan[] = [];
  const right: ParsedSpan[] = [];
  for (const span of spans) {
    if (span.x < gutter && span.x + span.width > gutter) full.push(span);
    else if (span.x + span.width <= gutter) left.push(span);
    else right.push(span);
  }

  return [...toLines(full), ...toLines(left), ...toLines(right)];
}

// ---------------------------------------------------------------------------
// Stage 4 — table detection
// ---------------------------------------------------------------------------

interface Cell {
  text: string;
  x: number;
}

/** Split a line into cells wherever an unusually wide horizontal gap appears. */
function splitCells(line: ParsedLine): Cell[] {
  const cells: Cell[] = [];
  let buffer = "";
  let startX = line.spans[0]?.x ?? line.x;

  for (let i = 0; i < line.spans.length; i++) {
    const span = line.spans[i];
    if (i > 0) {
      const prev = line.spans[i - 1];
      const gap = span.x - (prev.x + prev.width);
      // A gap wider than ~1.5em reads as a column separator, not a word space.
      if (gap > prev.fontSize * 1.5) {
        cells.push({ text: buffer.trim(), x: startX });
        buffer = "";
        startX = span.x;
      } else if (gap > prev.fontSize * 0.18 && !/\s$/.test(buffer)) {
        buffer += " ";
      }
    }
    buffer += span.text;
  }
  if (buffer.trim()) cells.push({ text: buffer.trim(), x: startX });
  return cells;
}

/**
 * Groups consecutive lines whose cell x-positions align into a table.
 * Returns index ranges that should be treated as tables.
 */
function findTables(lines: ParsedLine[]): { start: number; end: number; rows: string[][] }[] {
  const cellRows = lines.map(splitCells);
  const tables: { start: number; end: number; rows: string[][] }[] = [];
  let i = 0;

  while (i < lines.length) {
    if (cellRows[i].length < 2) {
      i++;
      continue;
    }
    // Extend while subsequent rows have a comparable number of aligned columns.
    let j = i + 1;
    const anchor = cellRows[i].map((c) => c.x);
    while (j < lines.length && cellRows[j].length >= 2) {
      const xs = cellRows[j].map((c) => c.x);
      const aligned = xs.filter((x) =>
        anchor.some((ax) => Math.abs(ax - x) <= Math.max(6, lines[j].fontSize))
      ).length;
      if (aligned < Math.min(2, xs.length)) break;
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

function classifyHeading(line: ParsedLine, bodySize: number): number | null {
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
  let listItems: string[] = [];
  let listOrdered = false;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join(" ").trim(), page });
      paragraph = [];
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
      continue;
    }

    // A continuation line of the current list item (indented, no marker).
    if (listItems.length) {
      const prev = lines[i - 1];
      if (prev && Math.abs(line.x - prev.x) < 4 && line.x > lines[0].x + 4) {
        listItems[listItems.length - 1] += " " + line.text;
        continue;
      }
      flushList();
    }

    paragraph.push(line.text);

    // Break the paragraph when the next line is far below or clearly indented.
    const next = lines[i + 1];
    if (!next) {
      flushParagraph();
    } else {
      const gap = line.y - next.y;
      const endsSentence = /[.!?]["')\]]?$/.test(line.text);
      if (gap > line.fontSize * 1.8 || (endsSentence && next.x > line.x + 8)) {
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

/** Parse a PDF into a structured document tree. */
export async function parseDocument(
  data: Uint8Array,
  onProgress?: (page: number, total: number) => void
): Promise<ParsedDocument> {
  const pdfjsLib = await getPdfjs();
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise;

  const perPage: { lines: ParsedLine[]; page: number }[] = [];
  const allSizes: number[] = [];
  let totalChars = 0;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const spans = toSpans(content.items as unknown as RawItem[]);
    totalChars += spans.reduce((n, s) => n + s.text.trim().length, 0);

    const lines = linesInReadingOrder(spans, viewport.width);
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
    blocks.push(...buildBlocks(lines, bodySize, page));
  }

  const pageCount = doc.numPages;
  doc.destroy();

  return {
    blocks,
    pageCount,
    bodySize,
    likelyScanned: totalChars < pageCount * 40,
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

export function extractTables(doc: ParsedDocument): TableBlock[] {
  return doc.blocks.filter((b): b is TableBlock => b.type === "table");
}

export function tableToCsv(table: TableBlock): string {
  return table.rows
    .map((row) =>
      row
        .map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
        .join(",")
    )
    .join("\n");
}

export interface Chunk {
  /** Heading breadcrumb, e.g. "Report > Q3 > Revenue". */
  path: string;
  text: string;
  page: number;
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
        path: headings.join(" > "),
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
    if (buffer.length + text.length > maxChars) {
      flush();
      bufferPage = block.page;
    }
    buffer += (buffer ? "\n\n" : "") + text;
  }
  flush();
  return chunks;
}
