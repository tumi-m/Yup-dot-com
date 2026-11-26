/**
 * A translated document as a PDF: its headings, paragraphs, lists and
 * tables laid out on A4 pages by the Markdown to PDF layout
 * (lib/pdf/text-to-pdf), in Noto Sans, which draws Latin, Greek, Cyrillic
 * and Devanagari. The text is set as plain text: nothing in it is read as
 * Markdown or HTML. Languages in other scripts come as DOCX only
 * (docxOnlyReason in lib/translate/languages.ts).
 */
import { PDFDocument } from "pdf-lib";
import { stopIfAborted } from "../../abort";
import type { ParsedDocument } from "../parse";
import { FontBook, type Face, type FontFiles } from "../text-to-pdf/fonts";
import { PAGE_NUMBER_TEXT, Writer, type Span } from "../text-to-pdf/layout";
import { draw, type Block } from "../text-to-pdf/markdown";
import { MARGINS, PAGE_SIZES } from "../text-to-pdf/options";
import { assertDrawable, missingNote, type Progress, type TextPdf } from "../text-to-pdf/index";

/** Body type size in points; headings scale from it as Markdown to PDF's do. */
const BASE = 11;
const HEADING_SCALE = [2, 1.6, 1.35, 1.15, 1, 0.92];

export interface TranslatedPdfOptions {
  /** The document's title, kept in the file's details. */
  title: string;
  /** The translation's language (BCP 47), set as the file's language. */
  lang: string;
  /** For messages: the file the translation came from. */
  name: string;
}

/** Every text of the document with the face it is set in. */
function texts(doc: ParsedDocument): [string, Face][] {
  const out: [string, Face][] = [];
  for (const b of doc.blocks) {
    if (b.type === "heading") out.push([b.text, "bold"]);
    else if (b.type === "paragraph") out.push([b.text, "regular"]);
    else if (b.type === "list") for (const item of b.items) out.push([item, "regular"]);
    else b.rows.forEach((row, r) => row.forEach((cell) => out.push([cell, r === 0 ? "bold" : "regular"])));
  }
  return out;
}

function blocksOf(doc: ParsedDocument, book: FontBook): Block[] {
  const blocks: Block[] = [];
  const span = (text: string, face: Face, size: number): Span => ({ text, face, size });
  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading": {
        const size = BASE * (HEADING_SCALE[Math.min(6, b.level) - 1] ?? 1);
        blocks.push({ kind: "text", spans: [span(b.text, "bold", size)], indent: 0, before: size * 0.9, after: size * 0.4, keep: true, quote: [] });
        break;
      }
      case "paragraph":
        blocks.push({ kind: "text", spans: [span(b.text, "regular", BASE)], indent: 0, before: 0, after: BASE * 0.8, quote: [] });
        break;
      case "list": {
        const markers = b.items.map((_, i) => (b.ordered ? `${i + 1}.` : "•"));
        const markerWidth = Math.max(BASE * 1.4, ...markers.map((m) => book.width(m, "regular", BASE) + BASE * 0.6));
        b.items.forEach((item, i) => {
          blocks.push({
            kind: "text",
            spans: [span(item, "regular", BASE)],
            indent: markerWidth,
            before: 0,
            after: i === b.items.length - 1 ? BASE * 0.8 : BASE * 0.2,
            marker: [span(markers[i], "regular", BASE)],
            markerWidth,
            quote: [],
          });
        });
        break;
      }
      case "table": {
        const size = BASE * 0.95;
        const [head = [], ...rows] = b.rows;
        const cols = Math.max(1, ...b.rows.map((r) => r.length));
        blocks.push({
          kind: "table",
          head: head.map((cell) => [span(cell, "bold", size)]),
          rows: rows.map((row) => row.map((cell) => [span(cell, "regular", size)])),
          align: Array.from({ length: cols }, () => "left" as const),
          indent: 0,
          before: BASE * 0.2,
          after: BASE * 0.9,
          quote: [],
        });
        break;
      }
    }
  }
  return blocks;
}

export async function translatedPdf(
  doc: ParsedDocument,
  o: TranslatedPdfOptions,
  fonts: FontFiles,
  onProgress?: Progress,
  signal?: AbortSignal
): Promise<TextPdf> {
  const all = texts(doc);
  if (!all.some(([t]) => t.trim())) throw new Error(`${o.name}: there is no text to lay out.`);
  const pdf = await PDFDocument.create();
  const book = new FontBook(pdf, fonts);
  for (const [text, face] of all) book.need(text, face);
  book.need(PAGE_NUMBER_TEXT, "regular", false);
  book.need("•0123456789.", "regular", false);
  onProgress?.(0, "Loading the font");
  await book.ready();
  assertDrawable(book, ["regular", "bold"], o.name);
  stopIfAborted(signal);

  const writer = new Writer(pdf, book, { ...PAGE_SIZES.a4, margin: MARGINS.normal, pageNumbers: true });
  writer.newPage();
  await draw(writer, book, blocksOf(doc, book), onProgress, signal);
  writer.finish();
  stopIfAborted(signal);
  onProgress?.(1, "Saving");
  pdf.setTitle(o.title);
  pdf.setLanguage(o.lang);
  pdf.setCreator("PDF Wizard");
  return { bytes: await pdf.save(), note: missingNote(book) };
}
