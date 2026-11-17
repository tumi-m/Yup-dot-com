/**
 * JPEGs and PNGs into one PDF, a page per picture. Only pdf-lib and the image
 * codec, so it runs in a Web Worker (off-thread.ts) as well as here.
 */
import { PDFDocument, type PDFPage } from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { drawOrientedImage, imageSize, jpegOrientation, orientedSize, sniffImage } from "../images";
import { embedImage, type EmbeddedImage } from "../embed-image";

export interface ImagesToPdfOptions {
  /** "fit" (a page the size of each picture) or "a4". */
  pageSize: string;
  /** In points. */
  margin: string;
}

const A4 = { w: 595.28, h: 841.89 };
const MAX_PAGE_PT = 14400;

export async function imagesToPdf(
  files: File[],
  opts: ImagesToPdfOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const margin = Number(opts.margin) || 0;

  for (const [i, file] of files.entries()) {
    stopIfAborted(signal);
    if (files.length > 1) onProgress?.(i / files.length, `Image ${i + 1} of ${files.length}`);
    const data = new Uint8Array(await file.arrayBuffer());
    const kind = sniffImage(data);
    if (!kind) throw new Error(`${file.name}: use a JPG or PNG image.`);
    const size = imageSize(data, kind);
    if (!size) throw new Error(`${file.name}: this image looks damaged.`);
    const orientation = kind === "jpeg" ? jpegOrientation(data) : 1;
    const shown = orientedSize(size, orientation);

    let page: PDFPage;
    let rect: { x: number; y: number; width: number; height: number };
    // The picture is right-sized for 300 DPI at its drawn size times this.
    let print = 1;
    if (opts.pageSize === "fit") {
      // 1 px = 1 pt, capped at the 200-inch page limit PDF viewers enforce.
      const scale = Math.min(1, (MAX_PAGE_PT - margin * 2) / Math.max(shown.width, shown.height));
      const w = shown.width * scale;
      const h = shown.height * scale;
      page = out.addPage([w + margin * 2, h + margin * 2]);
      rect = { x: margin, y: margin, width: w, height: h };
      // At 1 pt per pixel a phone photo makes a 42-inch page, which no one
      // prints or views at that size: size it for A4 paper instead. A long
      // screenshot (over two sheets at A4 width) is printed on many sheets at
      // its width, so it is sized for that width.
      const long = Math.max(w, h);
      const short = Math.min(w, h);
      const strip = long / short > (2 * A4.h) / A4.w;
      print = Math.min(1, strip ? A4.w / short : A4.h / long);
    } else {
      // A wide picture gets a landscape sheet.
      const landscape = shown.width > shown.height;
      const [pw, ph] = landscape ? [A4.h, A4.w] : [A4.w, A4.h];
      page = out.addPage([pw, ph]);
      const maxW = pw - margin * 2;
      const maxH = ph - margin * 2;
      const ratio = Math.min(maxW / shown.width, maxH / shown.height);
      const w = shown.width * ratio;
      const h = shown.height * ratio;
      rect = { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h };
    }

    // Size on the page in the image's stored orientation, for right-sizing.
    const sideways = orientation >= 5;
    const fit = { widthPt: (sideways ? rect.height : rect.width) * print, heightPt: (sideways ? rect.width : rect.height) * print };
    let img: EmbeddedImage;
    try {
      img = await embedImage(out, data, kind, size, fit);
    } catch {
      throw new Error(`${file.name}: this image looks damaged.`);
    }
    drawOrientedImage(page, img, orientation, rect);
  }
  return out.save();
}
