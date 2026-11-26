/**
 * Photos for Scan to PDF, in the browser: a camera frame or a picked photo
 * becomes an upright JPEG of at most 12 MP (all a page needs, and it keeps
 * twenty captures to tens of MB), its paper is looked for on a small copy,
 * and small pictures of the flattened page are made for the tray. Only the
 * JPEG and a thumbnail are kept per page; pixels are made from the JPEG when
 * a page is opened, and let go when it closes.
 */
import type { RawImage } from "../../image-codec";
import { findDocument } from "./detect";
import { insetQuad, type Quad } from "./geometry";
import { flattenPage, type ScanPage } from "./page";

/** The most pixels a photo is kept at. */
export const MAX_PHOTO_PIXELS = 12e6;
/** Pixels across the copy shown for dragging the corners. */
export const VIEW_LONG = 1600;

export interface Photo {
  blob: Blob;
  width: number;
  height: number;
  /** Where the paper is: found, or a box a little in from the edges. */
  quad: Quad;
  found: boolean;
}

function canvasOf(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This photo is too large for this device.");
  return { canvas, ctx };
}

/** Lets a canvas's memory go now rather than at the next collection. */
const release = (canvas: HTMLCanvasElement) => {
  canvas.width = canvas.height = 0;
};

function fit(width: number, height: number, maxPixels: number) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function fromSource(source: CanvasImageSource, width: number, height: number): Promise<Photo> {
  const size = fit(width, height, MAX_PHOTO_PIXELS);
  const full = canvasOf(size.width, size.height);
  full.ctx.drawImage(source, 0, 0, size.width, size.height);
  const blob = await new Promise<Blob | null>((resolve) => full.canvas.toBlob(resolve, "image/jpeg", 0.92));
  // The paper is looked for on a small copy: a few milliseconds.
  const small = fit(size.width, size.height, 512 * 384);
  const look = canvasOf(small.width, small.height);
  look.ctx.drawImage(full.canvas, 0, 0, small.width, small.height);
  const pixels = look.ctx.getImageData(0, 0, small.width, small.height);
  release(full.canvas);
  release(look.canvas);
  if (!blob) throw new Error("This photo is too large for this device.");
  const found = findDocument({ data: pixels.data, width: small.width, height: small.height });
  return { blob, width: size.width, height: size.height, quad: found?.quad ?? insetQuad(), found: !!found };
}

/** The frame the camera shows now. */
export async function photoFromVideo(video: HTMLVideoElement): Promise<Photo> {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) throw new Error("The camera isn't ready yet. Try again in a moment.");
  return fromSource(video, w, h);
}

/** A photo file, turned upright as the gallery shows it. */
export async function photoFromFile(file: Blob): Promise<Photo> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This picture couldn't be opened. Use a JPG, PNG, WebP or HEIC photo.");
  }
  try {
    return await fromSource(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** The photo's pixels at most `long` across, for the corner view and previews. */
export async function photoPixels(photo: Photo, long = VIEW_LONG): Promise<RawImage> {
  const scale = Math.min(1, long / Math.max(photo.width, photo.height));
  const width = Math.max(1, Math.round(photo.width * scale));
  const height = Math.max(1, Math.round(photo.height * scale));
  const bitmap = await createImageBitmap(photo.blob);
  const { canvas, ctx } = canvasOf(width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  release(canvas);
  return { data, width, height };
}

/** Pixels onto a canvas. */
export function paint(canvas: HTMLCanvasElement, img: RawImage) {
  canvas.width = img.width;
  canvas.height = img.height;
  canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
}

/** A small JPEG of the flattened page, as an object URL (revoke it when the page goes). */
export async function thumbnailUrl(pixels: RawImage, page: Omit<ScanPage, "image">, long = 360): Promise<string> {
  const flat = flattenPage(pixels, page, long);
  const { canvas } = canvasOf(flat.width, flat.height);
  paint(canvas, flat);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  release(canvas);
  if (!blob) throw new Error("This page couldn't be shown.");
  return URL.createObjectURL(blob);
}
