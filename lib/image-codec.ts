/**
 * JPEG encode/decode with MozJPEG compiled to WebAssembly.
 *
 * MozJPEG (trellis quantisation, tuned tables) gives the same bytes in every
 * browser and in Node, and can write one-channel gray JPEGs, which a canvas
 * can't. At equal SSIM its files measured about the size of Chromium's own
 * encoder (95–103% on photos and a scan). Decoding through it ignores EXIF
 * rotation and embedded colour profiles, which is what a PDF viewer does with
 * an image stream too.
 *
 * In the browser the .wasm files are served from /vendor (scripts/copy-vendor.mjs).
 * Node tests hand the compiled modules in with useJpegWasm().
 */
import encodeWasm, { init as initEncoder } from "@jsquash/jpeg/encode.js";
import decodeWasm, { init as initDecoder } from "@jsquash/jpeg/decode.js";

export const JSQUASH_JPEG_VERSION = "1.6.0";

/** 8-bit RGBA pixels, row by row. */
export interface RawImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface JpegOptions {
  /** 1–100, MozJPEG's scale (see mozQuality for the browser equivalent). */
  quality: number;
  /** One channel instead of three; for pictures with no colour. */
  gray?: boolean;
  /**
   * Progressive files are a few percent smaller. Off by default: some printers
   * and older PDF readers only handle baseline JPEGs.
   */
  progressive?: boolean;
  /**
   * Colour at full resolution (4:4:4) instead of halved both ways (4:2:0).
   * Browsers do this at quality 1: sharp coloured text and lines stay clean.
   */
  fullChroma?: boolean;
}

const vendorUrl = (file: string) => `${globalThis.location?.origin ?? ""}/vendor/jsquash-jpeg/${JSQUASH_JPEG_VERSION}/${file}`;

async function compile(file: string): Promise<WebAssembly.Module> {
  const url = vendorUrl(file);
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(fetch(url));
    } catch {
      // Served with the wrong MIME type: fall through to a plain fetch.
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("The image encoder didn't load.");
  return WebAssembly.compile(await res.arrayBuffer());
}

let encoderReady: Promise<void> | null = null;
let decoderReady: Promise<void> | null = null;

/** For Node (tests): use these compiled modules instead of fetching from /vendor. */
export async function useJpegWasm(modules: { encoder?: WebAssembly.Module; decoder?: WebAssembly.Module }) {
  if (modules.encoder) encoderReady = initEncoder(modules.encoder);
  if (modules.decoder) decoderReady = initDecoder(modules.decoder);
  await Promise.all([encoderReady, decoderReady]);
}

function loadEncoder() {
  encoderReady ??= compile("mozjpeg_enc.wasm").then((m) => initEncoder(m));
  // A failed load may be retried on the next call.
  return encoderReady.catch((err) => {
    encoderReady = null;
    throw err;
  });
}

function loadDecoder() {
  decoderReady ??= compile("mozjpeg_dec.wasm").then((m) => initDecoder(m));
  return decoderReady.catch((err) => {
    decoderReady = null;
    throw err;
  });
}

/**
 * The MozJPEG quality that matches `browserQuality` (0–1) from canvas.toBlob,
 * fitted on SSIM against Chromium 141 over 0.3–0.9 (0.4 → 58, 0.6 → 72, 0.8 → 87).
 */
export function mozQuality(browserQuality: number): number {
  return Math.max(1, Math.min(100, Math.round(browserQuality * 72 + 29)));
}

/** RGBA → JPEG. Alpha is ignored (flatten onto a background first if it matters). */
export async function encodeJpeg(image: RawImage, opts: JpegOptions): Promise<Uint8Array> {
  await loadEncoder();
  const out = await encodeWasm(image as ImageData, {
    quality: Math.max(1, Math.min(100, Math.round(opts.quality))),
    baseline: !opts.progressive,
    progressive: !!opts.progressive,
    optimize_coding: true,
    // MozJPEG's colour-space enum: 1 = grayscale, 3 = YCbCr.
    color_space: opts.gray ? 1 : 3,
    // 4:2:0 chroma: the eye barely sees colour detail, and it halves the colour data twice over.
    auto_subsample: false,
    chroma_subsample: opts.fullChroma ? 1 : 2,
  });
  return new Uint8Array(out);
}

/** JPEG → RGBA. Throws on CMYK and damaged files. */
export async function decodeJpeg(bytes: Uint8Array): Promise<RawImage> {
  await loadDecoder();
  // A fresh copy: `bytes` may be a view into a larger buffer (a Node Buffer's slice() is not a copy).
  const copy = new Uint8Array(bytes).buffer as ArrayBuffer;
  const img = await decodeWasm(copy, { preserveOrientation: false });
  return { data: img.data, width: img.width, height: img.height };
}

/** True when every pixel is a shade of grey: such a JPEG needs only one channel. */
export function isGray(img: RawImage): boolean {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) return false;
  return true;
}

/** A canvas's pixels, or null where they can't be read. */
export function canvasPixels(canvas: HTMLCanvasElement): RawImage | null {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data, width, height };
  } catch {
    return null;
  }
}

/**
 * Canvas pixels → JPEG with MozJPEG, falling back to the browser's encoder if
 * the wasm can't load. Pass `pixels` when they have been read already.
 * Grey renders get a one-channel JPEG; at quality 1 colour is kept at full
 * resolution, as the browser does.
 */
export async function canvasToJpeg(
  canvas: HTMLCanvasElement,
  browserQuality: number,
  opts: { progressive?: boolean; pixels?: RawImage | null } = {}
): Promise<Uint8Array> {
  try {
    const pixels = opts.pixels ?? canvasPixels(canvas);
    if (pixels) {
      return await encodeJpeg(pixels, {
        quality: mozQuality(browserQuality),
        progressive: opts.progressive,
        gray: isGray(pixels),
        fullChroma: browserQuality >= 1,
      });
    }
  } catch {
    // Fall back below.
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", browserQuality));
  if (!blob) throw new Error("This page is too large to render on this device.");
  return new Uint8Array(await blob.arrayBuffer());
}
