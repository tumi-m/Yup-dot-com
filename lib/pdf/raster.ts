import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { loadForRender } from "./render";
import { canvasToJpeg } from "../image-codec";
import { textLayer, type OcrText } from "./ocr-layer";
import { stopIfAborted } from "../abort";

/**
 * Rebuilds a PDF from pictures of its pages: pdf.js draws each page as the
 * reader sees it (annotations and form fields included), the picture becomes
 * a JPEG, and a new page of the same displayed size shows it. Nothing of the
 * original document is kept unless asked: no text, fields, links, scripts or
 * attachments. One page is drawn at a time and its canvas is freed at once.
 *
 * Used by Flatten PDF (everything as images) and by Compress PDF for files
 * pdf-lib can't read.
 */
export interface RasterOptions {
  /** Render scale: 1 is 72 DPI. */
  scale: number;
  /** JPEG quality, 0..1 as the browser counts it. */
  quality: number;
  /** Lays the page's own text over the picture, invisible, so it can still be searched and copied. */
  keepText?: boolean;
  /** A fresh canvas; Node tests pass node-canvas. */
  canvas?: () => HTMLCanvasElement;
  progress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

/** A turn for the page between pages, so progress paints and Cancel is heard. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function pagesAsImages(bytes: Uint8Array, opts: RasterOptions): Promise<Uint8Array> {
  const loaded = await loadForRender(bytes);
  const out = await PDFDocument.create();
  let font: PDFFont | undefined;
  const makeCanvas = opts.canvas ?? (() => document.createElement("canvas"));
  try {
    for (let i = 1; i <= loaded.numPages; i++) {
      stopIfAborted(opts.signal);
      opts.progress?.((i - 1) / loaded.numPages, `Page ${i} of ${loaded.numPages}`);
      const vp = await loaded.getPageViewport(i, opts.scale);
      const canvas = makeCanvas();
      let jpeg: Uint8Array;
      try {
        await loaded.renderPage(i, canvas, opts.scale, { pixelRatio: 1 });
        jpeg = await canvasToJpeg(canvas, opts.quality);
      } finally {
        canvas.width = canvas.height = 0; // release the bitmap now, not at GC time
      }
      stopIfAborted(opts.signal);
      const img = await out.embedJpg(jpeg);
      // The displayed size: a page turned by /Rotate comes out upright.
      const page = out.addPage([vp.baseWidth, vp.baseHeight]);
      page.drawImage(img, { x: 0, y: 0, width: vp.baseWidth, height: vp.baseHeight });
      if (opts.keepText) {
        const pieces = await loaded.ownText(i);
        if (pieces.length) {
          font ??= await out.embedFont(StandardFonts.Helvetica);
          // Measured in displayed points from the top-left, as OCR words are in pixels.
          const text: OcrText = {
            widthPt: vp.baseWidth,
            heightPt: vp.baseHeight,
            imageWidth: vp.baseWidth,
            imageHeight: vp.baseHeight,
            words: pieces.map((p) => ({ text: p.text, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, confidence: 100 })),
          };
          const key = page.node.newFontDictionary("F", font.ref);
          page.pushOperators(...textLayer(font, key, text, 0));
        }
      }
      await loaded.release(i);
      await breathe();
    }
  } finally {
    loaded.destroy();
  }
  return out.save();
}
