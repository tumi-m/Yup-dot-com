import { PDFBool, PDFDocument, PDFName, StandardFonts, degrees, rgb, type PDFFont } from "pdf-lib";
import { pageFrame } from "./page-frame";
import { WATERMARK_TEXT } from "../edit-usage";

/**
 * The small "Made with PDF Wizard" mark on Free files from Edit PDF, Sign PDF
 * and Edit PPTX: real text in the page content, bottom-right of the page as
 * the reader sees it (CropBox and /Rotate respected), muted grey at 60%.
 */
const SIZE = 8;
const MARGIN = 10;
/** Set on a page once it carries the mark, so saving again never stacks a second one. */
const MARKED = PDFName.of("PDFWizardMark");

export function isWatermarked(page: { node: { get(key: PDFName): unknown } }): boolean {
  return page.node.get(MARKED) === PDFBool.True;
}

/** Stamps every page that doesn't carry the mark yet. */
export async function stampWatermark(doc: PDFDocument, font?: PDFFont): Promise<void> {
  const f = font ?? (await doc.embedFont(StandardFonts.Helvetica));
  for (const page of doc.getPages()) {
    if (isWatermarked(page)) continue;
    const frame = pageFrame(page);
    const margin = Math.min(MARGIN, frame.width / 20, frame.height / 20);
    const unit = f.widthOfTextAtSize(WATERMARK_TEXT, 1);
    const size = Math.max(1, Math.min(SIZE, (frame.width - 2 * margin) / unit));
    const { x, y } = frame.toPdf(frame.width - margin - unit * size, margin);
    page.drawText(WATERMARK_TEXT, {
      x,
      y,
      size,
      font: f,
      color: rgb(0.45, 0.45, 0.45),
      opacity: 0.6,
      rotate: degrees(frame.angle(0)),
    });
    page.node.set(MARKED, PDFBool.True);
  }
}

/** Returns a copy of the PDF with the mark on every page. */
export async function watermarkPdf(bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  await stampWatermark(doc);
  return doc.save();
}
