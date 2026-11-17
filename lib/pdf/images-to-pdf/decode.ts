/**
 * Pictures the PDF can't take as they are (WebP, GIF, BMP, AVIF, HEIC, SVG)
 * become pixels through the browser's own decoders, upright as the browser
 * shows them. Bitmap formats decode in a worker as well as on the page; SVG
 * needs an <img>, so it is drawn on the page.
 */
import type { RawImage } from "../../image-codec";
import { FORMAT_NAMES, HEIC_MESSAGE, svgSize, type ImageFormat } from "./formats";

/** One picture to place on a page. */
export interface Frame {
  pixels: RawImage;
  /** Size to lay the page out with, in pixels (an SVG's own size, not its raster's). */
  width: number;
  height: number;
  /** EXIF orientation still to apply when drawing (1: the pixels are upright). */
  orientation: number;
}

/**
 * At most this many pixels from a browser decode: iOS Safari leaves a larger
 * canvas blank, and a print page needs far fewer (A4 at 300 DPI is 8.7 MP).
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

const MIME: Partial<Record<ImageFormat, string>> = {
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  jpeg: "image/jpeg",
  png: "image/png",
};

function context2d(width: number, height: number) {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== "undefined") canvas = new OffscreenCanvas(width, height);
  else {
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("This image is too large to convert on this device.");
  return { canvas, ctx };
}

/** A size of no more than MAX_CANVAS_PIXELS with the same shape. */
export function canvasFit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

function readPixels(source: CanvasImageSource, width: number, height: number): RawImage {
  const { canvas, ctx } = context2d(width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  // Lets the canvas memory go now rather than at the next collection.
  canvas.width = canvas.height = 0;
  return { data, width, height };
}

/** True where this code can decode pictures (a browser or its workers; not Node). */
export const canDecodeBitmaps = () =>
  typeof createImageBitmap === "function" && (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined");

/** The pixel size a picture of this size needs on its page, or null when it needs all of them. */
export type Want = (width: number, height: number) => { width: number; height: number } | null;

/**
 * A bitmap format (WebP, GIF's first frame, BMP, AVIF, HEIC where supported)
 * to pixels, no more than `want` asks for: the browser shrinks a big photo
 * far faster than a script can.
 */
export async function decodeBitmap(bytes: Uint8Array, format: ImageFormat, name: string, want?: Want): Promise<Frame> {
  if (!canDecodeBitmaps()) throw new Error(`${name}: ${FORMAT_NAMES[format]} images can't be opened here.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: MIME[format] ?? "" }));
  } catch {
    throw new Error(format === "heic" ? `${name}: ${HEIC_MESSAGE}` : `${name}: this image looks damaged.`);
  }
  try {
    const { width, height } = bitmap;
    let fit = canvasFit(width, height);
    const needed = want?.(width, height);
    if (needed && needed.width < fit.width) fit = needed;
    if (fit.width !== width) {
      // Shrunk by the browser, so a 50 MP photo never needs a 200 MB canvas.
      const small = await createImageBitmap(bitmap, { resizeWidth: fit.width, resizeHeight: fit.height, resizeQuality: "high" });
      bitmap.close();
      bitmap = small;
    }
    return { pixels: readPixels(bitmap, fit.width, fit.height), width, height, orientation: 1 };
  } finally {
    bitmap.close();
  }
}

/**
 * An SVG drawn at print size: as large as a canvas allows up to 4096 pixels
 * on its long side (A4 at 300 DPI needs 3508). Its width and height are set
 * to that size first, so it is drawn as vectors at that size, not stretched.
 * Page only (needs <img>). An <img> never runs an SVG's scripts or fetches
 * what it links to.
 */
export async function decodeSvg(bytes: Uint8Array, name: string): Promise<Frame> {
  const text = new TextDecoder().decode(bytes);
  const own = svgSize(text) ?? { width: 300, height: 150 };
  const long = Math.max(own.width, own.height);
  const scale = Math.min(4096 / long, Math.max(3508 / long, 300 / 72));
  const raster = canvasFit(Math.max(1, Math.round(own.width * scale)), Math.max(1, Math.round(own.height * scale)));
  const sized = sizeSvg(text, own, raster);
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error(`${name}: this SVG couldn't be drawn. Check that it opens in a browser.`);
    }
    return { pixels: readPixels(img, raster.width, raster.height), width: own.width, height: own.height, orientation: 1 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The SVG with its root's width and height set to `to`, and a viewBox so its drawing scales with them. */
export function sizeSvg(text: string, own: { width: number; height: number }, to: { width: number; height: number }): string {
  return text.replace(/<svg\b[^>]*>/i, (root) => {
    const hasBox = /\sviewBox\s*=/i.test(root);
    let out = root.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    const attrs = ` width="${to.width}" height="${to.height}"${hasBox ? "" : ` viewBox="0 0 ${own.width} ${own.height}"`}`;
    out = out.replace(/^<svg\b/i, `<svg${attrs}`);
    return out;
  });
}
