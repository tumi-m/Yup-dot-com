/**
 * Lays text out on PDF pages with pdf-lib: words wrapped to the page width
 * (a word longer than a line is broken), new pages as they fill, links that
 * can be clicked, and page numbers. Shared by Text and Markdown to PDF.
 */
import { PDFString, rgb, type PDFDocument, type PDFPage, type RGB } from "pdf-lib";
import type { Face, FontBook } from "./fonts";

export interface Span {
  text: string;
  face: Face;
  size: number;
  color?: RGB;
  /** A web or mail address the text opens. */
  link?: string;
  /** Inline code: a shaded box behind it. */
  code?: boolean;
  strike?: boolean;
}

export interface PageSetup {
  width: number;
  height: number;
  margin: number;
  pageNumbers: boolean;
}

/** One stretch of a line in one style, at `x` from the line's start. */
export interface Item {
  span: Span;
  text: string;
  x: number;
  width: number;
}

export interface Line {
  items: Item[];
  width: number;
  /** The largest type on the line. */
  size: number;
}

export const INK = rgb(0.1, 0.1, 0.12);
export const MUTED = rgb(0.4, 0.4, 0.45);
export const LINK = rgb(0.06, 0.33, 0.8);
export const RULE = rgb(0.8, 0.8, 0.83);
export const SHADE = rgb(0.95, 0.95, 0.96);

/** More pages than this is a mistake (a log, a dump): the browser tab would run out of memory first. */
export const MAX_PAGES = 5000;
/** The letters the page numbers are drawn with. */
export const PAGE_NUMBER_TEXT = "Page 0123456789 of";

/** Line height per point of type; Noto's ascender and descender take 1.362 em. */
export const LEADING = 1.4;

/** Only these open from a PDF; anything else (javascript:, file:, a relative path) is plain text. */
export function safeLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined;
    // ASCII only (punycode, percent-escapes), as a PDF string must be.
    return /^[\x21-\x7e]+$/.test(url.href) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A literal PDF string. pdf-lib writes PDFString.of's text as it is, so a
 * lone ")" or a trailing "\" in a link would end the string early and break
 * the file; they are escaped here.
 */
export function pdfString(text: string): PDFString {
  return PDFString.of(text.replace(/[\\()]/g, (c) => `\\${c}`));
}

type Part = { span: Span; text: string };
type Atom = { kind: "word" | "space"; parts: Part[] } | { kind: "break"; span: Span };

/** Words, spaces and hard breaks; a word can run across styles ("**bold**ly"). */
function atoms(spans: Span[]): Atom[] {
  const out: Atom[] = [];
  for (const span of spans) {
    for (const m of span.text.matchAll(/\n|[ ]+|[^ \n]+/g)) {
      const text = m[0];
      const kind = text === "\n" ? "break" : text[0] === " " ? "space" : "word";
      if (kind === "break") {
        out.push({ kind, span });
        continue;
      }
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.parts.push({ span, text });
      else out.push({ kind, parts: [{ span, text }] });
    }
  }
  return out;
}

/**
 * Breaks spans into lines no wider than `width`. With `keepSpaces` (plain
 * text, code) runs of spaces keep their width, including at the start, so
 * indents and columns line up; elsewhere spaces collapse and a line never
 * starts with one. Spaces where a line wraps are dropped either way.
 */
export function wrap(book: FontBook, spans: Span[], width: number, keepSpaces = false): Line[] {
  const lines: Line[] = [];
  const base = spans[0]?.size ?? 10;
  let parts: Part[] = [];
  let used = 0;
  let pending: Part[] | null = null;
  let start = true;
  const measure = (ps: Part[]) => ps.reduce((n, p) => n + book.width(p.text, p.span.face, p.span.size), 0);

  const flush = () => {
    lines.push(toLine(book, parts, base));
    parts = [];
    used = 0;
    pending = null;
    start = false;
  };
  const place = (word: Part[]) => {
    const w = measure(word);
    if (used + w <= width + 0.01) {
      parts.push(...word);
      used += w;
      return;
    }
    // Longer than a line: as many letters as fit, then the rest on the next lines.
    for (const part of word) {
      let chunk = "";
      for (const ch of part.text) {
        const cw = book.width(chunk + ch, part.span.face, part.span.size);
        if (used + cw > width && (chunk || parts.length)) {
          if (chunk) parts.push({ span: part.span, text: chunk });
          flush();
          chunk = ch;
        } else chunk += ch;
      }
      if (chunk) {
        parts.push({ span: part.span, text: chunk });
        used += book.width(chunk, part.span.face, part.span.size);
      }
    }
  };

  for (const atom of atoms(spans)) {
    if (atom.kind === "break") {
      flush();
      start = true;
      continue;
    }
    if (atom.kind === "space") {
      if (keepSpaces && start && !parts.length) {
        // An indent: kept, wrapped like a word if it is wider than the line.
        place(atom.parts);
      } else if (parts.length) {
        pending = keepSpaces ? atom.parts : [{ span: atom.parts[0].span, text: " " }];
      }
      continue;
    }
    const w = measure(atom.parts);
    const sw = pending ? measure(pending) : 0;
    if (parts.length && used + sw + w > width + 0.01) {
      flush();
    } else if (pending) {
      parts.push(...pending);
      used += sw;
    }
    pending = null;
    place(atom.parts);
  }
  if (parts.length || !lines.length || start) flush();
  return lines;
}

/** Joins neighbouring parts in one style and measures where each starts. */
function toLine(book: FontBook, parts: Part[], base: number): Line {
  const items: Item[] = [];
  let x = 0;
  let size = parts.length ? 0 : base;
  for (const p of parts) {
    const w = book.width(p.text, p.span.face, p.span.size);
    const last = items[items.length - 1];
    if (last && last.span === p.span) {
      last.text += p.text;
      last.width += w;
    } else items.push({ span: p.span, text: p.text, x, width: w });
    x += w;
    size = Math.max(size, p.span.size);
  }
  return { items, width: x, size };
}

/** Distance from a line's top to its baseline, for type of `size` in a line `height` tall. */
const baselineDrop = (size: number, height: number) => (height - 1.362 * size) / 2 + 1.069 * size;

export class Writer {
  readonly pages: PDFPage[] = [];
  private page: PDFPage | null = null;
  /** The top of the free space on the page, in PDF units from the bottom. */
  y = 0;
  /** Open quote bars: their x and where on this page they start. */
  private bars: { x: number; top: number }[] = [];

  constructor(
    private doc: PDFDocument,
    private book: FontBook,
    readonly setup: PageSetup
  ) {}

  get left() {
    return this.setup.margin;
  }
  get width() {
    return this.setup.width - 2 * this.setup.margin;
  }
  private get top() {
    return this.setup.height - this.setup.margin;
  }
  private get bottom() {
    return this.setup.margin;
  }
  /** True before anything is drawn on the current page. */
  get atTop() {
    return !this.page || this.y >= this.top;
  }
  /** Room left on this page. */
  get room() {
    return this.page ? this.y - this.bottom : 0;
  }
  /** Room on an empty page. */
  get pageRoom() {
    return this.top - this.bottom;
  }

  newPage() {
    if (this.pages.length >= MAX_PAGES) {
      throw new Error(`This makes more than ${MAX_PAGES.toLocaleString("en-US")} pages. Split the file into smaller parts first.`);
    }
    this.closeBars();
    this.page = this.doc.addPage([this.setup.width, this.setup.height]);
    this.pages.push(this.page);
    this.y = this.top;
    for (const bar of this.bars) bar.top = this.y;
  }

  /** Starts a new page unless `height` fits on this one. */
  ensure(height: number) {
    if (!this.page || (height > this.room && !this.atTop)) this.newPage();
  }

  /** Vertical space, left out at the top of a page. */
  gap(height: number) {
    if (this.atTop) return;
    if (height >= this.room) this.newPage();
    else this.y -= height;
  }

  /** Draws `line` with its left edge `indent` points into the text area. */
  line(line: Line, indent = 0, height = line.size * LEADING, align: "left" | "center" | "right" = "left", room = this.width - indent) {
    this.ensure(height);
    const shift = align === "right" ? room - line.width : align === "center" ? (room - line.width) / 2 : 0;
    this.drawItems(line, this.left + indent + Math.max(0, shift), this.y - baselineDrop(line.size, height));
    this.y -= height;
  }

  /** Draws a line's text with its baseline at `baseline`, starting at `x`. Doesn't move down. */
  drawItems(line: Line, x: number, baseline: number) {
    const page = this.page!;
    for (const item of line.items) {
      const { span } = item;
      const at = x + item.x;
      if (span.code) {
        page.drawRectangle({ x: at - 1.5, y: baseline - span.size * 0.28, width: item.width + 3, height: span.size * 1.3, color: SHADE });
      }
      let pen = at;
      for (const run of this.book.runs(item.text, span.face)) {
        if (!run.font?.font) {
          this.book.dropped(run.text);
          continue;
        }
        page.drawText(run.text, { x: pen, y: baseline, size: span.size, font: run.font.font, color: span.color ?? INK });
        pen += this.book.width(run.text, span.face, span.size);
      }
      if (span.link) {
        page.drawLine({ start: { x: at, y: baseline - span.size * 0.12 }, end: { x: at + item.width, y: baseline - span.size * 0.12 }, thickness: span.size * 0.06, color: span.color ?? LINK });
        this.link(span.link, at, baseline - span.size * 0.3, item.width, span.size * 1.3);
      }
      if (span.strike) {
        page.drawLine({ start: { x: at, y: baseline + span.size * 0.3 }, end: { x: at + item.width, y: baseline + span.size * 0.3 }, thickness: span.size * 0.06, color: span.color ?? INK });
      }
    }
  }

  /** A clickable area that opens `url`. */
  link(url: string, x: number, y: number, width: number, height: number) {
    if (width <= 0) return;
    const annot = this.doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + width, y + height],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: pdfString(url) },
    });
    this.page!.node.addAnnot(this.doc.context.register(annot));
  }

  /** A filled box from the current position down `height` points. */
  shade(x: number, width: number, height: number, color = SHADE) {
    this.page!.drawRectangle({ x, y: this.y - height, width, height, color });
  }

  /** A horizontal rule at the current position, from `indent` across the text area or `width` long. */
  rule(indent = 0, color = RULE, thickness = 0.75, width = this.width - indent) {
    this.ensure(thickness);
    this.page!.drawLine({ start: { x: this.left + indent, y: this.y }, end: { x: this.left + indent + width, y: this.y }, thickness, color });
  }

  /** Starts a quote's bar at `indent`; it runs down the page until endBar(). */
  beginBar(indent: number) {
    if (!this.page) this.newPage();
    this.bars.push({ x: this.left + indent, top: this.y });
  }

  endBar() {
    const bar = this.bars.pop();
    if (bar) this.drawBar(bar, this.y);
  }

  private drawBar(bar: { x: number; top: number }, bottom: number) {
    if (!this.page || bar.top - bottom < 1) return;
    this.page.drawRectangle({ x: bar.x, y: bottom, width: 2.5, height: bar.top - bottom, color: RULE });
  }

  /** Bars running off the bottom of the page end there. */
  private closeBars() {
    for (const bar of this.bars) this.drawBar(bar, this.bottom);
  }

  /** Numbers the pages, once every page exists. */
  finish() {
    if (!this.pages.length) this.newPage();
    if (!this.setup.pageNumbers) return;
    const n = this.pages.length;
    const size = 8.5;
    const y = Math.max(12, this.setup.margin / 2 - size / 2);
    this.pages.forEach((page, i) => {
      this.page = page;
      const text = `Page ${i + 1} of ${n}`;
      const width = this.book.width(text, "regular", size);
      const line: Line = { items: [{ span: { text, face: "regular", size, color: MUTED }, text, x: 0, width }], width, size };
      this.drawItems(line, (this.setup.width - width) / 2, y);
    });
  }
}

