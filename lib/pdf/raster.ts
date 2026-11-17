import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { loadForRender } from "./render";
import { canvasToJpeg } from "../jpeg-encode/off-thread";
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
  /**
   * Refuses work that would hold more than this many pixels of pictures, or
   * MAX_JPEG_BYTES of them, before anything is drawn: every page's picture
   * stays in memory until the file is written, and a phone tab runs out.
   */
  maxPixels?: number;
}

/** About 115 A4 pages at 300 DPI, 460 at 150 DPI. */
export const MAX_PIXELS = 1_000_000_000;
/** The pictures themselves, as they are made: a busy page compresses far less than a page of text. */
export const MAX_JPEG_BYTES = 400 * 1024 * 1024;

/** The pictures would be too big to build here; `pixels` is how many there would be (NaN: they compress too little). */
export class TooManyPixelsError extends Error {
  constructor(readonly pixels: number) {
    super("These pages are too big to turn into pictures here.");
  }
}

/** A turn for the page between pages, so progress paints and Cancel is heard. */
const breathe = () => new Promise((resolve) => setTimeout(resolve, 0));

export async function pagesAsImages(bytes: Uint8Array, opts: RasterOptions): Promise<Uint8Array> {
  const loaded = await loadForRender(bytes);
  const out = await PDFDocument.create();
  let font: PDFFont | undefined;
  const makeCanvas = opts.canvas ?? (() => document.createElement("canvas"));
  let made = 0;
  try {
    if (!loaded.numPages) throw new Error("This PDF has no pages.");
    if (opts.maxPixels) {
      // Page sizes only, which pdf.js reads without drawing; stops as soon as it is too much.
      let pixels = 0;
      for (let i = 1; i <= loaded.numPages; i++) {
        stopIfAborted(opts.signal);
        const vp = await loaded.getPageViewport(i, opts.scale);
        pixels += vp.width * vp.height;
        if (pixels > opts.maxPixels) throw new TooManyPixelsError((pixels / i) * loaded.numPages);
      }
    }
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
      made += jpeg.length;
      if (opts.maxPixels && made > MAX_JPEG_BYTES) throw new TooManyPixelsError(NaN);
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
  // pdf-lib adds a blank page to a document with none; this one always has its own.
  return out.save({ addDefaultPage: false });
}
