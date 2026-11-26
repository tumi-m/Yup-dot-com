/**
 * Text and Markdown files to PDF, laid out with pdf-lib in an embedded
 * Unicode font (fonts.ts, layout.ts). Runs in a Web Worker (off-thread.ts)
 * or here; nothing leaves the device.
 */
import { PDFDocument } from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { FontBook, type Face, type FontFiles } from "./fonts";
import { LEADING, PAGE_NUMBER_TEXT, wrap, Writer } from "./layout";
import { readTextOptions, type TextToPdfOptions } from "./options";
import { cleanText, decodeText, expandTabs } from "./read-text";

export type { TextToPdfOptions } from "./options";

export interface TextPdf {
  bytes: Uint8Array;
  /** Said with the result when letters were left out. */
  note?: string;
}

export type Progress = (fraction: number, label: string) => void;

/** Lets a cancel, and the page on the main thread, get a word in. */
export const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What to say about letters the fonts don't have. */
export function missingNote(book: FontBook): string | undefined {
  if (!book.missing) return undefined;
  const sample = [...book.missingSample].join(" ");
  const count = book.missing === 1 ? "1 character" : `${book.missing.toLocaleString("en-US")} characters`;
  return `Left out ${count} the font doesn't have (${sample}). It covers Latin, Greek, Cyrillic and Devanagari letters.`;
}

/** Turned away before layout: nothing in the file could be drawn. */
export function noLettersMessage(sample: string): string {
  return `none of this text can be drawn (for example ${sample}). The font covers Latin, Greek, Cyrillic and Devanagari letters; Chinese, Japanese, Korean, Arabic and Hebrew aren't supported yet.`;
}

/** Throws when no letter of the text can be drawn (all Chinese, say): an empty PDF helps no one. */
export function assertDrawable(book: FontBook, faces: Face[], name: string) {
  const all = faces.map((f) => book.coverage(f));
  if (all.some((c) => c.drawable)) return;
  const sample = [...new Set(all.flatMap((c) => c.missing))].slice(0, 3).join(" ");
  if (sample) throw new Error(`${name}: ${noLettersMessage(sample)}`);
}

export async function textToPdf(
  bytes: Uint8Array,
  name: string,
  opts: Partial<TextToPdfOptions>,
  fonts: FontFiles,
  onProgress?: Progress,
  signal?: AbortSignal
): Promise<TextPdf> {
  const { setup, size, mono } = readTextOptions(opts);
  let text: string;
  try {
    text = cleanText(decodeText(bytes));
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!text.trim()) throw new Error(`${name}: this file has no text.`);
  const face: Face = mono ? "mono" : "regular";

  const doc = await PDFDocument.create();
  const book = new FontBook(doc, fonts);
  book.need(text, face);
  book.need(PAGE_NUMBER_TEXT, "regular", false);
  onProgress?.(0, "Loading the font");
  await book.ready();
  assertDrawable(book, [face], name);

  const writer = new Writer(doc, book, setup);
  writer.newPage();
  const height = size * LEADING;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i % 400 === 0) {
      stopIfAborted(signal);
      onProgress?.(i / lines.length, `Page ${writer.pages.length}`);
      await breathe();
    }
    // A form feed starts a new page, as a printer does.
    const pieces = lines[i].split("\f");
    for (const [k, piece] of pieces.entries()) {
      if (k > 0) writer.newPage();
      if (!piece && k > 0) continue;
      for (const line of wrap(book, [{ text: expandTabs(piece), face, size }], writer.width, true)) writer.line(line, 0, height);
    }
  }
  writer.finish();
  stopIfAborted(signal);
  onProgress?.(1, "Saving");
  doc.setTitle(name.replace(/\.[^.]+$/, ""));
  return { bytes: await doc.save(), note: missingNote(book) };
}
