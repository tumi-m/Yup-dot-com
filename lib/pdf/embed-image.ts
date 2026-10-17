import type { PDFDocument, PDFRef } from "pdf-lib";
import { canvasPixels, canvasToJpeg, decodeJpeg, encodeJpeg, isGray, type RawImage } from "../image-codec";
import { downsampleTarget, resizeRgba } from "../image-fit";
import {
  canDeflate,
  countColors,
  decodePng,
  embedFlate,
  encodeFlate,
  flateSize,
  flatness,
  isOpaque,
  pngAsIs,
  readPng,
  type FlateImage,
} from "./flate-image";
import { jpegChannels } from "./images";

/**
 * Puts a user's JPEG or PNG into a PDF at the best quality per byte:
 *
 * - Shown above 300 DPI, it is scaled down to 300 DPI, kept only when that
 *   saves at least 15% (a JPEG is re-encoded with MozJPEG).
 * - PNG photos become JPEG when that is less than half the size; graphics
 *   (screenshots, scans, logos) stay lossless and are copied over as stored
 *   whenever a PDF can take the PNG's data unchanged.
 *
 * Anything that can't be improved (CMYK JPEGs, 16-bit or interlaced PNGs,
 * pictures too big to decode safely on a phone, no encoder available) is
 * embedded exactly as before.
 *
 * encodeRender makes the same JPEG-or-lossless choice for rendered pages and
 * slides.
 */

/**
 * MozJPEG quality for photos this app re-encodes at 300 DPI: about the
 * browser's 0.9, and measured indistinguishable from the original in print
 * (SSIM 0.98 on a phone photo).
 */
const PHOTO_QUALITY = 93;
/** A smaller copy must save at least this much to replace the original. */
const MIN_SAVING = 0.15;
/**
 * Larger pictures (108 and 200 MP phone modes) go in as they are: decoding one
 * takes a gigabyte or more of memory, which can crash a phone's browser tab.
 */
const MAX_DECODE_PIXELS = 50e6;

/** Photos have many colours and few runs of identical neighbours; screenshots the opposite. */
export function looksPhotographic(img: RawImage): boolean {
  return isOpaque(img) && countColors(img, 4096) > 4096 && flatness(img) < 0.5;
}

export interface EmbeddedImage {
  ref: PDFRef;
  /** Pixel size of what was embedded (stored orientation). */
  width: number;
  height: number;
}

type Choice = { jpeg: Uint8Array } | { flate: FlateImage };
const choiceSize = (c: Choice) => ("jpeg" in c ? c.jpeg.length : flateSize(c.flate));

async function smallestLossless(pixels: RawImage, asIs: FlateImage | null): Promise<FlateImage> {
  // Palette and packed PNGs are as small as lossless gets; others may shrink.
  if (asIs && (asIs.palette || asIs.bitsPerComponent < 8)) return asIs;
  const encoded = await encodeFlate(pixels);
  return asIs && flateSize(asIs) <= flateSize(encoded) ? asIs : encoded;
}

/** Best encoding of PNG pixels: JPEG for photos when much smaller, else lossless. */
async function bestForPixels(pixels: RawImage, asIs: FlateImage | null): Promise<Choice> {
  if (looksPhotographic(pixels)) {
    try {
      const jpeg = await encodeJpeg(pixels, { quality: PHOTO_QUALITY, gray: isGray(pixels) });
      // Compare with the PNG's own data where there is one; skip a second lossless encode.
      const lossless = asIs ?? (await encodeFlate(pixels));
      if (jpeg.length <= flateSize(lossless) * 0.5) return { jpeg };
      return { flate: asIs ? await smallestLossless(pixels, asIs) : lossless };
    } catch {
      // No JPEG encoder here: lossless below.
    }
  }
  return { flate: await smallestLossless(pixels, asIs) };
}

async function pngChoice(bytes: Uint8Array, fit?: { widthPt: number; heightPt: number }): Promise<Choice | null> {
  const png = readPng(bytes);
  if (!png) return null;
  if (png.width * png.height > MAX_DECODE_PIXELS) {
    const asIs = pngAsIs(png);
    return asIs ? { flate: asIs } : null;
  }
  const pixels = await decodePng(png);
  if (!pixels) return null;
  const asIs = pngAsIs(png);
  const full = await bestForPixels(pixels, asIs);
  const target = fit && downsampleTarget(pixels.width, pixels.height, fit.widthPt, fit.heightPt);
  if (!target) return full;
  const small = await bestForPixels(resizeRgba(pixels, target.width, target.height), null);
  return choiceSize(small) <= choiceSize(full) * (1 - MIN_SAVING) ? small : full;
}

async function jpegBytes(bytes: Uint8Array, size: { width: number; height: number }, fit?: { widthPt: number; heightPt: number }) {
  const target = fit && downsampleTarget(size.width, size.height, fit.widthPt, fit.heightPt);
  // CMYK can't be decoded here: it stays as it is.
  const channels = jpegChannels(bytes);
  if (!target || (channels !== 1 && channels !== 3) || size.width * size.height > MAX_DECODE_PIXELS) return bytes;
  try {
    // decodeJpeg ignores EXIF, so the pixels keep their stored orientation;
    // the caller still applies the original file's orientation when drawing.
    const small = resizeRgba(await decodeJpeg(bytes), target.width, target.height);
    const jpeg = await encodeJpeg(small, { quality: PHOTO_QUALITY, gray: channels === 1 || isGray(small) });
    return jpeg.length <= bytes.length * (1 - MIN_SAVING) ? jpeg : bytes;
  } catch {
    // Damaged, or no decoder here: the original as it is.
    return bytes;
  }
}

/**
 * Embeds an image that will be drawn `fit` points large (in its stored
 * orientation); without `fit` it is never scaled down.
 */
export async function embedImage(
  doc: PDFDocument,
  bytes: Uint8Array,
  kind: "png" | "jpeg",
  size: { width: number; height: number },
  fit?: { widthPt: number; heightPt: number }
): Promise<EmbeddedImage> {
  if (kind === "jpeg") {
    const img = await doc.embedJpg(await jpegBytes(bytes, size, fit));
    return { ref: img.ref, width: img.width, height: img.height };
  }
  let choice: Choice | null = null;
  try {
    choice = await pngChoice(bytes, fit);
  } catch {
    // Unusual PNG, or no deflate here: pdf-lib's own embedding below.
  }
  if (!choice) {
    const img = await doc.embedPng(bytes);
    return { ref: img.ref, width: img.width, height: img.height };
  }
  if ("jpeg" in choice) {
    const img = await doc.embedJpg(choice.jpeg);
    return { ref: img.ref, width: img.width, height: img.height };
  }
  return { ref: embedFlate(doc, choice.flate), width: choice.flate.width, height: choice.flate.height };
}

/** Renders at least this flat (text, shapes, charts) are worth a lossless try. */
const FLAT = 0.6;

/**
 * A rendered page or slide: JPEG (MozJPEG), or lossless when the render is
 * flat and that is no bigger, which keeps text edges crisp. Browser only.
 */
export async function encodeRender(
  canvas: HTMLCanvasElement,
  browserQuality: number
): Promise<{ jpeg: Uint8Array } | { flate: FlateImage }> {
  const pixels = canvasPixels(canvas);
  const jpeg = await canvasToJpeg(canvas, browserQuality, { pixels });
  return pixels ? smallerRender(pixels, jpeg) : { jpeg };
}

/** The JPEG, or the lossless encoding of the same pixels when the render is flat and that is no bigger. */
export async function smallerRender(pixels: RawImage, jpeg: Uint8Array): Promise<{ jpeg: Uint8Array } | { flate: FlateImage }> {
  if (!canDeflate() || flatness(pixels) < FLAT) return { jpeg };
  try {
    const flate = await encodeFlate(pixels);
    // A small photo on a text slide can make lossless the bigger of the two.
    if (flateSize(flate) <= jpeg.length) return { flate };
  } catch {
    // Keep the JPEG.
  }
  return { jpeg };
}
