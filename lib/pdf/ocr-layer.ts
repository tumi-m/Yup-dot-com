import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  StandardFonts,
  TextRenderingMode,
  beginText,
  concatTransformationMatrix,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFFont,
} from "pdf-lib";
import { embedFlate, type FlateImage } from "./flate-image";
import { drawOrientedImage } from "./images";
import { pageFrame, visibleBox } from "./page-frame";

/**
 * Makes a PDF *searchable* from OCR output: an invisible text layer laid
 * exactly over the recognised words — the same technique Acrobat's "Recognize
 * Text" uses. The text is drawn in render mode 3 (invisible), so it can be
 * selected, searched, and copied without changing how the page looks.
 *
 * addTextLayer puts it on the pages of an existing PDF; buildSearchablePdf
 * makes new pages from page images (slides, or PDFs that can't be edited).
 *
 * Kept free of browser APIs so it can be unit-tested in Node.
 */

export interface OcrWord {
  text: string;
  /** Bounding box in image pixels, top-left origin. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
  /**
   * The line's baseline under the word and the line's text size, in image
   * pixels: the words of a line share them. Without, the word's own box is used.
   */
  baseline?: number;
  size?: number;
}

/** What Tesseract reads of one line: the parts used here. */
export interface OcrLine {
  bbox?: { x0: number; y0: number; x1: number; y1: number };
  baseline?: { x0: number; y0: number; x1: number; y1: number; has_baseline?: boolean };
  words: { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }[];
}

/**
 * A line's words for the text layer, on the line's baseline at the line's
 * size. A word's own box drops with its descenders and shrinks without
 * ascenders, so "problem" sat lower and "a" smaller than "Boil", and copied
 * text came out in the wrong order. A bullet read as a sign or a stray
 * letter ("©", or an unsure "eo"), well apart from the words after it,
 * becomes "•", so the copied text is a list (specks of dust stay specks).
 */
export function lineWords(line: OcrLine): OcrWord[] {
  const box = line.bbox;
  if (!box) return line.words.map((w) => ({ text: w.text, confidence: w.confidence, ...w.bbox }));
  const b = line.baseline;
  const sloped = b && b.has_baseline !== false && b.x1 > b.x0;
  const baseAt = (x: number) => (sloped ? b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0) : box.y1 - (box.y1 - box.y0) * 0.2);
  // The tallest letters rise about three quarters of the size above the baseline.
  const size = Math.max(1, (baseAt((box.x0 + box.x1) / 2) - box.y0) / 0.75);
  return line.words.map((w, i) => {
    const next = line.words[i + 1];
    const t = w.text.trim();
    const stray = /^[^\p{L}\p{N}]{1,2}$/u.test(t) || (/^\p{L}{1,2}$/u.test(t) && w.confidence < 80);
    const bullet = i === 0 && !!next && stray && next.bbox.x0 - w.bbox.x1 > size && /[\p{L}\p{N}]/u.test(next.text);
    return {
      text: bullet ? "•" : w.text,
      confidence: bullet ? 100 : w.confidence,
      ...w.bbox,
      baseline: baseAt((w.bbox.x0 + w.bbox.x1) / 2),
      size,
    };
  });
}

/** Words recognised on one page, measured on a render of the page as displayed. */
export interface OcrText {
  /** Page size in PDF points. */
  widthPt: number;
  heightPt: number;
  /** Pixel size of the render the word boxes refer to. */
  imageWidth: number;
  imageHeight: number;
  words: OcrWord[];
  /** Words read but left out because the page's own text already has them. */
  known?: number;
  /**
   * Degrees clockwise the page was turned to be read (it lay sideways or upside
   * down): the words, sizes and render are of the page turned so.
   */
  turn?: 90 | 180 | 270;
}

const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;

/**
 * How a page read: its letters, and those in words read with confidence. A
 * page lying sideways or upside down reads as noise, with next to no sure
 * letters.
 */
export function readQuality(words: { text: string; confidence: number }[]) {
  let all = 0;
  let sure = 0;
  for (const w of words) {
    const n = letters(w.text);
    all += n;
    if (w.confidence >= 70) sure += n;
  }
  return { all, sure };
}

/** Worth reading turned: text was there, but few of its letters were sure. */
export function readsBadly(q: { all: number; sure: number }) {
  return q.all >= 20 && q.sure < q.all * 0.4;
}

/** The turned read is the page's: far more sure letters, and mostly sure. */
export function readsBetter(turned: { all: number; sure: number }, upright: { all: number; sure: number }) {
  return turned.sure >= 20 && turned.sure >= upright.sure * 2 && turned.sure >= turned.all * 0.5;
}

/** The rendered page itself: JPEG or PNG bytes, or lossless pixels ready for the PDF. */
export type PageImage = { imageType: "jpeg" | "png"; image: Uint8Array } | { imageType: "flate"; image: FlateImage };

export type OcrPage = OcrText & PageImage;

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

/**
 * True when a page's own text layer has most of the words OCR read off it,
 * i.e. it is real text, not garbled by a broken font encoding.
 */
export function textAgrees(ocrWords: { text: string }[], pageText: string): boolean {
  const read = ocrWords.flatMap((w) => wordsOf(w.text));
  if (!read.length) return true;
  const own = new Set(wordsOf(pageText));
  return read.filter((w) => own.has(w)).length >= read.length * 0.5;
}

/**
 * True when much of a page's text is characters no real text uses (control
 * codes, private-use glyphs, U+FFFD): fonts that don't say which letters
 * their glyphs are.
 */
export function looksGarbled(text: string): boolean {
  const chars = text.replace(/\s+/g, "");
  if (!chars) return false;
  const odd = chars.match(/[\p{Cc}\p{Co}\uFFFD]/gu)?.length ?? 0;
  return odd > chars.length * 0.1;
}

/** A piece of a page's own text, boxed in displayed points from the top-left. */
export interface OwnText {
  text: string;
  /** pdf.js's name for the font: a broken encoding garbles everything in that font. */
  font: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The OCR'd words a page's own text doesn't already have. A word is left out
 * where it sits on the page's own text and that text is real (in that font,
 * most words OCR read on it are in it too), so search and copy find each word
 * once. Words on pictures (a scanned signature, a pasted screenshot) and on
 * text garbled by a broken font encoding stay.
 */
export function newWords(src: OcrText, own: OwnText[]): OcrWord[] {
  if (!own.length) return src.words;
  const sx = src.widthPt / src.imageWidth;
  const sy = src.heightPt / src.imageHeight;
  const under = src.words.map((w) => {
    const x = ((w.x0 + w.x1) / 2) * sx;
    const y = ((w.y0 + w.y1) / 2) * sy;
    return own.find((t) => x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1);
  });
  const real = new Map<string, boolean>();
  for (const t of under) {
    if (!t || real.has(t.font)) continue;
    const read = src.words.filter((_, i) => under[i]?.font === t.font);
    const text = own.filter((o) => o.font === t.font).map((o) => o.text).join(" ");
    real.set(t.font, textAgrees(read, text));
  }
  return src.words.filter((_, i) => {
    const t = under[i];
    return !t || !real.get(t.font);
  });
}

/**
 * The standard fonts are WinAnsi-only; skip words they cannot encode. WinAnsi
 * has curly quotes, dashes, € and œ, which Word and PowerPoint text is full of.
 */
export function encodable(font: PDFFont, text: string) {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Invisible-text operators for one page, in displayed coordinates (points
 * from the bottom-left of the page as the reader sees it).
 */
export function textLayer(
  font: PDFFont,
  fontKey: string | PDFName,
  src: OcrText,
  minConfidence: number
): PDFOperator[] {
  const sx = src.widthPt / src.imageWidth;
  const sy = src.heightPt / src.imageHeight;
  const ops: PDFOperator[] = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];

  for (const w of src.words) {
    const text = w.text.trim();
    if (!text || w.confidence < minConfidence || !encodable(font, text)) continue;

    const boxW = (w.x1 - w.x0) * sx;
    const boxH = (w.y1 - w.y0) * sy;
    if (boxW <= 0 || boxH <= 0) continue;

    const size = Math.max(1, w.size !== undefined ? w.size * sy : boxH * 0.9);
    const natural = font.widthOfTextAtSize(text, size);
    // Stretch horizontally so the selection box matches the word on the image.
    const scalePct = natural > 0 ? (boxW / natural) * 100 : 100;
    // The line's baseline, or near the bottom of the box (~20% descender allowance).
    const baseline = w.baseline !== undefined ? src.heightPt - w.baseline * sy : src.heightPt - w.y1 * sy + boxH * 0.2;

    ops.push(
      setFontAndSize(fontKey, size),
      PDFOperator.of(Ops.SetTextHorizontalScaling, [PDFNumber.of(scalePct)]),
      setTextMatrix(1, 0, 0, 1, w.x0 * sx, baseline),
      showText(font.encodeText(text + " "))
    );
  }

  ops.push(endText());
  return ops;
}

export async function buildSearchablePdf(
  pages: OcrPage[],
  opts: { minConfidence?: number } = {}
): Promise<Uint8Array> {
  const minConfidence = opts.minConfidence ?? 30;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontKey = "OcrF";

  for (const src of pages) {
    const page = doc.addPage([src.widthPt, src.heightPt]);
    const img =
      src.imageType === "flate"
        ? { ref: embedFlate(doc, src.image) }
        : src.imageType === "jpeg"
          ? await doc.embedJpg(src.image)
          : await doc.embedPng(src.image);
    drawOrientedImage(page, img, 1, { x: 0, y: 0, width: src.widthPt, height: src.heightPt });

    // Register the font on the page so raw operators can reference it by name.
    page.node.setFontDictionary(PDFName.of(fontKey), font.ref);
    page.pushOperators(...textLayer(font, fontKey, src, minConfidence));
  }

  return doc.save();
}

/**
 * Adds the invisible text to the original PDF and leaves everything else as
 * it was, so size and sharpness match the input. `pages[i]` is page i + 1;
 * null leaves that page alone. Word boxes are measured on a render of the
 * page as displayed (pdf.js: CropBox clipped to the MediaBox, /Rotate
 * applied), and mapped back to the page's own coordinates here.
 */
export async function addTextLayer(
  doc: PDFDocument,
  pages: (OcrText | null)[],
  opts: { minConfidence?: number } = {}
): Promise<Uint8Array> {
  const minConfidence = opts.minConfidence ?? 30;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPages().forEach((page, i) => {
    const src = pages[i];
    if (!src || !src.words.length) return;
    const frame = pageFrame(page, visibleBox(page));
    const fontKey = page.node.newFontDictionary("OcrF", font.ref);
    // The render's size in points is the displayed box, whatever pdf.js measured.
    const shown = { ...src, widthPt: frame.width, heightPt: frame.height };
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(...frame.matrix),
      ...textLayer(font, fontKey, shown, minConfidence),
      popGraphicsState()
    );
  });
  return doc.save();
}
