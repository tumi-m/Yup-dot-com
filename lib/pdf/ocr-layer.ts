import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
} from "pdf-lib";

/**
 * Builds a *searchable* PDF from OCR output: each page is the scanned image
 * with an invisible text layer laid exactly over the recognised words — the
 * same technique Acrobat's "Recognize Text" uses. The text is drawn in render
 * mode 3 (invisible), so it can be selected, searched, and copied without
 * changing how the page looks.
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
}

export interface OcrPage {
  /** Page size in PDF points. */
  widthPt: number;
  heightPt: number;
  /** Rendered page image (JPEG or PNG bytes) and its pixel size. */
  image: Uint8Array;
  imageType: "jpeg" | "png";
  imageWidth: number;
  imageHeight: number;
  words: OcrWord[];
}

/** The standard fonts are WinAnsi-only; skip words they cannot encode. */
function encodable(text: string) {
  return /^[\x20-\x7E\xA0-\xFF]+$/.test(text);
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
      src.imageType === "jpeg" ? await doc.embedJpg(src.image) : await doc.embedPng(src.image);
    page.drawImage(img, { x: 0, y: 0, width: src.widthPt, height: src.heightPt });

    // Register the font on the page so raw operators can reference it by name.
    page.node.setFontDictionary(PDFName.of(fontKey), font.ref);

    const sx = src.widthPt / src.imageWidth;
    const sy = src.heightPt / src.imageHeight;
    const ops: PDFOperator[] = [beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];

    for (const w of src.words) {
      const text = w.text.trim();
      if (!text || w.confidence < minConfidence || !encodable(text)) continue;

      const boxW = (w.x1 - w.x0) * sx;
      const boxH = (w.y1 - w.y0) * sy;
      if (boxW <= 0 || boxH <= 0) continue;

      const size = Math.max(1, boxH * 0.9);
      const natural = font.widthOfTextAtSize(text, size);
      // Stretch horizontally so the selection box matches the word on the image.
      const scalePct = natural > 0 ? (boxW / natural) * 100 : 100;

      ops.push(
        setFontAndSize(fontKey, size),
        PDFOperator.of(Ops.SetTextHorizontalScaling, [PDFNumber.of(scalePct)]),
        // Baseline sits near the bottom of the box (~20% descender allowance).
        setTextMatrix(1, 0, 0, 1, w.x0 * sx, src.heightPt - w.y1 * sy + boxH * 0.2),
        showText(font.encodeText(text + " "))
      );
    }

    ops.push(endText());
    page.pushOperators(...ops);
  }

  return doc.save();
}
