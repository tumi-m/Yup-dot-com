/**
 * Markdown to PDF: the file is read with marked's lexer (MIT, loaded only
 * here) and its blocks are drawn with layout.ts: headings, paragraphs with
 * bold, italic, struck and inline code, links that can be clicked, lists
 * (numbered, bulleted, tasks, nested), quotes, code blocks, rules and simple
 * tables. HTML in the file is never rendered: its tags are dropped and the
 * words between them kept as text. Pictures it links to aren't fetched;
 * their description is shown instead.
 */
import { PDFDocument } from "pdf-lib";
import type { Token, Tokens } from "marked";
import { stopIfAborted } from "../../abort";
import { FontBook, type Face, type FontFiles } from "./fonts";
import { LEADING, LINK, MUTED, PAGE_NUMBER_TEXT, RULE, safeLink, SHADE, wrap, Writer, type Line, type Span } from "./layout";
import { readTextOptions, type TextToPdfOptions } from "./options";
import { cleanText, decodeText, expandTabs } from "./read-text";
import { assertDrawable, breathe, missingNote, type Progress, type TextPdf } from "./index";

// ---------------------------------------------------------------------------
// Blocks: the document as the layout draws it
// ---------------------------------------------------------------------------

type Align = "left" | "center" | "right";

type Block =
  | { kind: "text"; spans: Span[]; indent: number; before: number; after: number; marker?: Span[]; markerWidth?: number; keep?: boolean; quote: number[] }
  | { kind: "code"; lines: string[]; size: number; indent: number; before: number; after: number; quote: number[] }
  | { kind: "rule"; indent: number; before: number; after: number; quote: number[] }
  | { kind: "table"; head: Span[][]; rows: Span[][][]; align: Align[]; indent: number; before: number; after: number; quote: number[] };

interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: string;
  muted?: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·", deg: "°", euro: "€", pound: "£", times: "×" };

/** &amp;, &#233; and &#xE9; as the letters they stand for. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

/** The words of some HTML, without its tags, comments, scripts or styles. Nothing of it runs or is drawn as HTML. */
export function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?(-->|$)/g, "")
      .replace(/<(script|style|template)\b[\s\S]*?(<\/\1\s*>|$)/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

/** Quotes or lists deeper than this are drawn at this depth. Past it the indent leaves no room for words. */
export const MAX_QUOTE_DEPTH = 20;
/** Columns of indent a line keeps: about 20 levels of list. */
export const MAX_INDENT = 40;
export const TOO_DEEP = "this file is nested too deeply to lay out.";

/**
 * Flattens nesting past the limits before the file is read: marked works
 * through each level again for every level under it, so a few thousand
 * nested lists take minutes and gigabytes, and a few thousand ">" run it out
 * of stack. Lines inside fenced code keep their indent.
 */
export function limitNesting(source: string): string {
  let fence = "";
  return source
    .split("\n")
    .map((line) => {
      const quotes = /^(?: {0,3}>)+/.exec(line)?.[0] ?? "";
      const rest = line.slice(quotes.length);
      const mark = /^[ \t]*(`{3,}|~{3,})/.exec(rest)?.[1];
      if (fence) {
        if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = "";
        return line;
      }
      if (mark) fence = mark;
      let depth = 0;
      let keep = quotes;
      for (let i = 0; i < quotes.length; i++) {
        if (quotes[i] === ">" && ++depth === MAX_QUOTE_DEPTH) {
          keep = quotes.slice(0, i + 1);
          break;
        }
      }
      const indent = /^[ \t]*/.exec(rest)![0];
      const wide = expandTabs(indent).length > MAX_INDENT;
      if (keep === quotes && !wide) return line;
      return keep + (wide ? " ".repeat(MAX_INDENT) + rest.slice(indent.length) : rest);
    })
    .join("\n");
}

function faceOf(s: Style, heading: boolean): Face {
  const bold = s.bold || heading;
  if (s.code) return bold ? "monoBold" : "mono";
  if (bold && s.italic) return "boldItalic";
  if (bold) return "bold";
  return s.italic ? "italic" : "regular";
}

class Builder {
  blocks: Block[] = [];
  title = "";
  constructor(
    private book: FontBook,
    private size: number,
    private mono: boolean
  ) {}

  private span(text: string, style: Style, size: number, heading = false): Span {
    const face = this.mono && !style.code && !heading ? (style.bold ? "monoBold" : "mono") : faceOf(style, heading);
    this.book.need(text, face);
    return {
      text,
      face,
      size: style.code && !heading ? size * 0.92 : size,
      color: style.link ? LINK : style.muted ? MUTED : undefined,
      link: style.link,
      code: style.code && !this.mono,
      strike: style.strike,
    };
  }

  /** Inline tokens to spans. Soft line breaks are spaces; hard ones stay. */
  inline(tokens: Token[] | undefined, style: Style, size: number, heading = false): Span[] {
    const out: Span[] = [];
    // Inside an inline <script> or <style>: its contents are code, not words.
    let hidden = false;
    for (const t of tokens ?? []) {
      if (t.type === "html") {
        if (/^<(script|style)\b/i.test(t.text)) hidden = !/<\/(script|style)\s*>\s*$/i.test(t.text);
        else if (/^<\/(script|style)\b/i.test(t.text)) hidden = false;
      }
      if (hidden) continue;
      switch (t.type) {
        case "text":
          if ("tokens" in t && t.tokens?.length) out.push(...this.inline(t.tokens, style, size, heading));
          else out.push(this.span(decodeEntities(t.text).replace(/\n/g, " "), style, size, heading));
          break;
        case "escape":
          out.push(this.span(decodeEntities(t.text), style, size, heading));
          break;
        case "strong":
          out.push(...this.inline(t.tokens, { ...style, bold: true }, size, heading));
          break;
        case "em":
          out.push(...this.inline(t.tokens, { ...style, italic: true }, size, heading));
          break;
        case "del":
          out.push(...this.inline(t.tokens, { ...style, strike: true }, size, heading));
          break;
        case "codespan":
          out.push(this.span(t.text.replace(/\n/g, " "), { ...style, code: true }, size, heading));
          break;
        case "link": {
          const href = safeLink((t as Tokens.Link).href);
          out.push(...this.inline(t.tokens, href ? { ...style, link: href } : style, size, heading));
          break;
        }
        case "image": {
          const alt = decodeEntities((t as Tokens.Image).text).trim();
          out.push(this.span(alt ? `[Image: ${alt}]` : "[Image]", { ...style, italic: true, muted: true }, size, heading));
          break;
        }
        case "br":
          out.push(this.span("\n", style, size, heading));
          break;
        case "html":
          // Only a line break means anything once tags are dropped.
          if (/^<br\s*\/?>$/i.test(t.text.trim())) out.push(this.span("\n", style, size, heading));
          break;
        case "checkbox":
          // In the code font so the boxes line up, without code's shading.
          out.push({ ...this.span((t as { checked?: boolean }).checked ? "[x] " : "[ ] ", { ...style, code: true }, size), code: false });
          break;
        default:
          if ("tokens" in t && Array.isArray(t.tokens)) out.push(...this.inline(t.tokens, style, size, heading));
          else if ("text" in t && typeof t.text === "string") out.push(this.span(decodeEntities(t.text), style, size, heading));
      }
    }
    return out;
  }

  /** Block tokens, `indent` points in, inside the quotes whose bars sit at `quote`. */
  blocksOf(tokens: Token[], indent: number, quote: number[], tight = false) {
    const base = this.size;
    for (const t of tokens) {
      switch (t.type) {
        case "space":
        case "def":
        case "checkbox":
          break;
        case "heading": {
          const h = t as Tokens.Heading;
          const size = base * ([2, 1.6, 1.35, 1.15, 1, 0.92][h.depth - 1] ?? 1);
          const spans = this.inline(h.tokens, {}, size, true);
          if (!this.title && h.depth === 1) this.title = spans.map((s) => s.text).join("").trim();
          this.blocks.push({ kind: "text", spans, indent, before: size * 0.9, after: size * 0.4, keep: true, quote });
          break;
        }
        case "paragraph":
          this.blocks.push({ kind: "text", spans: this.inline(t.tokens, {}, base), indent, before: 0, after: tight ? base * 0.2 : base * 0.8, quote });
          break;
        case "text":
          // A tight list item's words.
          this.blocks.push({ kind: "text", spans: this.inline("tokens" in t && t.tokens ? t.tokens : [t], {}, base), indent, before: 0, after: base * 0.2, quote });
          break;
        case "blockquote": {
          const bar = indent + 2;
          this.blocksOf((t as Tokens.Blockquote).tokens, indent + 16, [...quote, bar]);
          break;
        }
        case "list":
          this.list(t as Tokens.List, indent, quote);
          break;
        case "code": {
          const size = base * 0.88;
          const text = (t as Tokens.Code).text.replace(/\n+$/, "");
          const lines = text.split("\n").map((l) => expandTabs(l));
          this.book.need(lines.join(""), "mono");
          this.blocks.push({ kind: "code", lines, size, indent, before: base * 0.2, after: base * 0.9, quote });
          break;
        }
        case "hr":
          this.blocks.push({ kind: "rule", indent, before: base * 0.6, after: base * 1.2, quote });
          break;
        case "table": {
          const table = t as Tokens.Table;
          const head = table.header.map((c) => this.inline(c.tokens, { bold: true }, base * 0.95));
          const rows = table.rows.map((r) => r.map((c) => this.inline(c.tokens, {}, base * 0.95)));
          const align = table.align.map((a) => (a === "center" || a === "right" ? a : "left"));
          this.blocks.push({ kind: "table", head, rows, align, indent, before: base * 0.2, after: base * 0.9, quote });
          break;
        }
        case "html": {
          const text = htmlText(t.text);
          if (text) this.blocks.push({ kind: "text", spans: [this.span(text, {}, base)], indent, before: 0, after: base * 0.8, quote });
          break;
        }
        default:
          if ("tokens" in t && Array.isArray(t.tokens)) this.blocksOf(t.tokens, indent, quote, tight);
          else if ("text" in t && typeof t.text === "string" && t.text.trim()) {
            this.blocks.push({ kind: "text", spans: [this.span(decodeEntities(t.text), {}, base)], indent, before: 0, after: base * 0.8, quote });
          }
      }
    }
  }

  private list(list: Tokens.List, indent: number, quote: number[], depth = 0) {
    const base = this.size;
    const start = typeof list.start === "number" ? list.start : 1;
    const markers = list.items.map((_, i) => (list.ordered ? `${start + i}.` : ["•", "–", "·"][depth % 3]));
    const face: Face = this.mono ? "mono" : "regular";
    for (const m of markers) this.book.need(m, face, false);
    const markerWidth = Math.max(base * 1.4, ...markers.map((m) => this.book.width(m, face, base) + base * 0.6));
    for (const [i, item] of list.items.entries()) {
      const from = this.blocks.length;
      // Nested lists are drawn by this method, one level deeper.
      const own = item.tokens.filter((t) => t.type !== "list");
      const before = this.blocks.length;
      for (const t of item.tokens) {
        if (t.type === "list") this.list(t as Tokens.List, indent + markerWidth, quote, depth + 1);
        else this.blocksOf([t], indent + markerWidth, quote, !list.loose);
      }
      if (!own.length && this.blocks.length === before) {
        // An empty item ("-" alone) still shows its marker.
        this.blocks.push({ kind: "text", spans: [this.span("", {}, base)], indent: indent + markerWidth, before: 0, after: base * 0.2, quote });
      }
      const first = this.blocks[from];
      if (first?.kind === "text") {
        first.marker = [{ text: markers[i], face, size: base }];
        first.markerWidth = markerWidth;
        if (item.task) first.spans.unshift(...this.inline([{ type: "checkbox", raw: "", checked: !!item.checked } as Token], {}, base));
      }
    }
    // Space after a list, not after a list inside one.
    const last = this.blocks[this.blocks.length - 1];
    if (last && depth === 0) last.after = Math.max(last.after, base * 0.8);
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Draws the blocks. Spacing between blocks is the larger of the two sides' asks. */
async function draw(writer: Writer, book: FontBook, blocks: Block[], onProgress?: Progress, signal?: AbortSignal) {
  let after = 0;
  let open: number[] = [];
  for (const [i, block] of blocks.entries()) {
    if (i % 50 === 0) {
      stopIfAborted(signal);
      onProgress?.(i / blocks.length, `Page ${writer.pages.length || 1}`);
      await breathe();
    }
    // Quote bars: close the ones this block is outside of, open the new ones.
    let keep = 0;
    while (keep < open.length && keep < block.quote.length && open[keep] === block.quote[keep]) keep++;
    const gap = Math.max(after, block.before);
    for (let k = open.length; k > keep; k--) writer.endBar();
    writer.gap(gap);
    open = open.slice(0, keep);
    for (const x of block.quote.slice(keep)) {
      writer.beginBar(x);
      open.push(x);
    }
    after = block.after;

    switch (block.kind) {
      case "text":
        drawText(writer, book, block);
        break;
      case "code":
        drawCode(writer, book, block);
        break;
      case "rule":
        writer.ensure(1);
        writer.rule(block.indent);
        break;
      case "table":
        drawTable(writer, book, block);
        break;
    }
  }
  for (let k = open.length; k > 0; k--) writer.endBar();
}

function drawText(writer: Writer, book: FontBook, block: Extract<Block, { kind: "text" }>) {
  const room = writer.width - block.indent;
  const lines = wrap(book, block.spans, room);
  const height = (l: Line) => l.size * LEADING;
  // A heading never sits alone at the foot of a page.
  if (block.keep) writer.ensure(lines.reduce((n, l) => n + height(l), 0) + (block.spans[0]?.size ?? 11) * LEADING * 2);
  for (const [i, line] of lines.entries()) {
    writer.ensure(height(line));
    if (i === 0 && block.marker) {
      const marker = block.marker[0];
      const markerLine: Line = { items: [{ span: marker, text: marker.text, x: 0, width: book.width(marker.text, marker.face, marker.size) }], width: 0, size: marker.size };
      const h = height(line);
      const baseline = writer.y - ((h - 1.362 * line.size) / 2 + 1.069 * line.size);
      writer.drawItems(markerLine, writer.left + block.indent - block.markerWidth!, baseline);
    }
    writer.line(line, block.indent, height(line));
  }
}

function drawCode(writer: Writer, book: FontBook, block: Extract<Block, { kind: "code" }>) {
  const pad = 6;
  const x = writer.left + block.indent;
  const width = writer.width - block.indent;
  const lh = block.size * 1.35;
  const lines = block.lines.flatMap((text) => wrap(book, [{ text, face: "mono", size: block.size }], width - pad * 2, true));
  let i = 0;
  while (i < lines.length) {
    // As many lines as fit on this page, on one shaded box.
    writer.ensure(lh + pad * 2);
    const fit = Math.max(1, Math.min(lines.length - i, Math.floor((writer.room - pad * 2) / lh)));
    writer.shade(x, width, fit * lh + pad * 2, SHADE);
    writer.y -= pad;
    for (const line of lines.slice(i, i + fit)) writer.line(line, block.indent + pad, lh);
    writer.y -= pad;
    i += fit;
    if (i < lines.length) writer.newPage();
  }
}

function drawTable(writer: Writer, book: FontBook, block: Extract<Block, { kind: "table" }>) {
  const padX = 5;
  const padY = 3;
  const cols = Math.max(block.head.length, ...block.rows.map((r) => r.length));
  if (!cols) return;
  const room = writer.width - block.indent;
  const natural = Array.from({ length: cols }, (_, c) =>
    // (+1: the text's own width would wrap its last letter on rounding.)
    Math.max(...[block.head, ...block.rows].map((r) => (r[c] ?? []).reduce((n, s) => n + book.width(s.text, s.face, s.size), 0))) + padX * 2 + 1
  );
  const longest = Array.from({ length: cols }, (_, c) =>
    Math.max(padX * 2 + 8, ...[block.head, ...block.rows].flatMap((r) => (r[c] ?? []).flatMap((s) => s.text.split(/\s+/).map((w) => book.width(w, s.face, s.size) + padX * 2))))
  );
  const total = natural.reduce((a, b) => a + b, 0);
  let widths = natural;
  if (total > room) {
    // Narrow every column in proportion, but no narrower than its longest word allows (or an even share).
    const floor = longest.map((l) => Math.min(l, room / cols));
    const spare = room - floor.reduce((a, b) => a + b, 0);
    const want = natural.map((n, c) => Math.max(0, n - floor[c]));
    const wanted = want.reduce((a, b) => a + b, 0) || 1;
    widths = floor.map((f, c) => f + (spare * want[c]) / wanted);
  }
  const x0 = writer.left + block.indent;
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  const size = block.head.flat()[0]?.size ?? 10;
  const layoutRow = (row: Span[][]) => widths.map((w, c) => wrap(book, row[c]?.length ? row[c] : [{ text: "", face: "regular", size }], w - padX * 2));
  const rowHeight = (cells: Line[][]) => Math.max(...cells.map((ls) => ls.reduce((n, l) => n + l.size * LEADING, 0))) + padY * 2;

  const head = layoutRow(block.head);
  const headHeight = rowHeight(head);
  const drawRow = (cells: Line[][], isHead: boolean) => {
    const h = rowHeight(cells);
    if (h > writer.pageRoom) {
      // Taller than a page: its cells one under another, so nothing is cut.
      for (const lines of cells) for (const line of lines) writer.line(line, block.indent + padX, line.size * LEADING);
      writer.rule(block.indent, RULE, 0.5, tableWidth);
      return;
    }
    if (h > writer.room && !writer.atTop) {
      writer.newPage();
      if (!isHead) drawRow(head, true);
    }
    if (isHead) writer.shade(x0, tableWidth, Math.min(h, writer.room), SHADE);
    const top = writer.y;
    let x = x0;
    let lowest = top;
    cells.forEach((lines, c) => {
      writer.y = top - padY;
      for (const line of lines) {
        writer.line(line, x - writer.left + padX, line.size * LEADING, block.align[c] ?? "left", widths[c] - padX * 2);
      }
      lowest = Math.min(lowest, writer.y - padY);
      x += widths[c];
    });
    writer.y = lowest;
    writer.rule(block.indent, isHead ? MUTED : RULE, isHead ? 0.9 : 0.5, tableWidth);
  };
  writer.ensure(headHeight + (block.rows.length ? rowHeight(layoutRow(block.rows[0])) : 0));
  drawRow(head, true);
  for (const row of block.rows) drawRow(layoutRow(row), false);
  // Room under the table's last rule.
  writer.y -= 0.5;
}

export async function markdownToPdf(
  bytes: Uint8Array,
  name: string,
  opts: Partial<TextToPdfOptions>,
  fonts: FontFiles,
  onProgress?: Progress,
  signal?: AbortSignal
): Promise<TextPdf> {
  const { setup, size, mono } = readTextOptions(opts);
  let source: string;
  try {
    source = cleanText(decodeText(bytes));
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!source.trim()) throw new Error(`${name}: this file has no text.`);
  const { Lexer } = await import("marked");
  stopIfAborted(signal);
  const doc = await PDFDocument.create();
  const book = new FontBook(doc, fonts);
  const builder = new Builder(book, size, mono);
  try {
    builder.blocksOf(new Lexer({ gfm: true }).lex(limitNesting(source)), 0, []);
  } catch (err) {
    // Nesting the limits don't catch (a list in a quote in a list..., on one line) can still run out of stack.
    if (err instanceof RangeError) throw new Error(`${name}: ${TOO_DEEP}`);
    throw err;
  }
  if (!builder.blocks.length) throw new Error(`${name}: this file has no text.`);
  book.need(PAGE_NUMBER_TEXT, "regular", false);
  onProgress?.(0, "Loading the font");
  await book.ready();
  assertDrawable(book, ["regular", "bold", "italic", "boldItalic", "mono", "monoBold"], name);

  const writer = new Writer(doc, book, setup);
  writer.newPage();
  await draw(writer, book, builder.blocks, onProgress, signal);
  writer.finish();
  stopIfAborted(signal);
  onProgress?.(1, "Saving");
  doc.setTitle(builder.title || name.replace(/\.[^.]+$/, ""));
  return { bytes: await doc.save(), note: missingNote(book) };
}
