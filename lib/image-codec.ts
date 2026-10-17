/**
 * JPEG encode/decode with MozJPEG compiled to WebAssembly.
 *
 * MozJPEG (trellis quantisation, tuned tables) makes files roughly 10–20%
 * smaller than a browser's built-in encoder at the same visual quality, and
 * gives the same bytes in every browser. Decoding through it ignores EXIF
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
  /** 1–100, MozJPEG's scale (about 5 points below the browser's for the same look). */
  quality: number;
  /** One channel instead of three; for pictures with no colour. */
  gray?: boolean;
  /**
   * Progressive files are a few percent smaller. Off by default: some printers
   * and older PDF readers only handle baseline JPEGs.
   */
  progressive?: boolean;
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

/** The quality setting for MozJPEG that looks like `browserQuality` (0–1) from canvas.toBlob. */
export function mozQuality(browserQuality: number): number {
  return Math.max(1, Math.min(100, Math.round(browserQuality * 100) - 5));
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
    chroma_subsample: 2,
  });
  return new Uint8Array(out);
}

/** JPEG → RGBA. Throws on CMYK and damaged files. */
export async function decodeJpeg(bytes: Uint8Array): Promise<RawImage> {
  await loadDecoder();
  const copy = bytes.slice().buffer as ArrayBuffer;
  const img = await decodeWasm(copy, { preserveOrientation: false });
  return { data: img.data, width: img.width, height: img.height };
}

/** Canvas pixels → JPEG with MozJPEG, falling back to the browser's encoder if the wasm can't load. */
export async function canvasToJpeg(canvas: HTMLCanvasElement, browserQuality: number): Promise<Uint8Array> {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return await encodeJpeg({ data, width, height }, { quality: mozQuality(browserQuality) });
    }
  } catch {
    // Fall back below.
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", browserQuality));
  if (!blob) throw new Error("This page is too large to render on this device.");
  return new Uint8Array(await blob.arrayBuffer());
}
