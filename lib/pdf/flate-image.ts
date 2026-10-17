import { PDFHexString, PDFName, PDFRawStream, type PDFDocument, type PDFRef } from "pdf-lib";
import type { RawImage } from "../image-codec";

/**
 * Lossless images for PDF, stored the way a PNG stores them: zlib with PNG
 * row filters (/Predictor 15), as greyscale, a palette of up to 256 colours or
 * RGB, plus an alpha channel as a soft mask.
 *
 * pdf-lib's embedPng turns every PNG into plain 8-bit RGB deflated without
 * row filters, which makes screenshots and slides several times larger than
 * the PNG they came from. Most PNGs can instead be copied over as they are.
 *
 * Runs in the browser and in Node (CompressionStream; no canvas).
 */

export interface FlateImage {
  width: number;
  height: number;
  /** Components per pixel: 1 for grey or palette indexes, 3 for RGB. */
  colors: 1 | 3;
  bitsPerComponent: 1 | 2 | 4 | 8;
  /** RGB triples when the pixels are palette indexes. */
  palette?: Uint8Array;
  /** zlib stream of filtered rows. */
  data: Uint8Array;
  /** Transparency, as a greyscale image of the same size. */
  alpha?: FlateImage;
}

/** Total bytes the image adds to a PDF (near enough). */
export function flateSize(img: FlateImage): number {
  return img.data.length + (img.palette?.length ?? 0) * 2 + (img.alpha ? flateSize(img.alpha) : 0);
}

async function zlib(data: Uint8Array, direction: "compress" | "decompress"): Promise<Uint8Array> {
  const Codec = direction === "compress" ? CompressionStream : DecompressionStream;
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new Codec("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True where this platform can deflate natively (every current browser, Node 18+). */
export function canDeflate(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

// ---------------------------------------------------------------------------
// PNG row filters
// ---------------------------------------------------------------------------

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** One row through PNG filter `f` (0 none, 1 sub, 2 up, 3 average, 4 paeth) into `out` at `at`. */
function filterRow(f: number, cur: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array, at: number) {
  const n = cur.length;
  switch (f) {
    case 0:
      out.set(cur, at);
      break;
    case 1:
      for (let i = 0; i < n; i++) out[at + i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
      break;
    case 2:
      for (let i = 0; i < n; i++) out[at + i] = cur[i] - prev[i];
      break;
    case 3:
      for (let i = 0; i < n; i++) out[at + i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1);
      break;
    default:
      for (let i = 0; i < n; i++) {
        out[at + i] = cur[i] - (i >= bpp ? paeth(cur[i - bpp], prev[i], prev[i - bpp]) : prev[i]);
      }
  }
}

/** Filter `f`'s output summed as signed bytes (libpng's heuristic), giving up once past `limit`. */
function rowCost(f: number, cur: Uint8Array, prev: Uint8Array, bpp: number, limit: number): number {
  const n = cur.length;
  let sum = 0;
  let v = 0;
  for (let i = 0; i < n && sum < limit; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    switch (f) {
      case 1:
        v = (cur[i] - a) & 255;
        break;
      case 2:
        v = (cur[i] - prev[i]) & 255;
        break;
      case 3:
        v = (cur[i] - ((a + prev[i]) >> 1)) & 255;
        break;
      default:
        v = (cur[i] - (i >= bpp ? paeth(a, prev[i], prev[i - bpp]) : prev[i])) & 255;
    }
    sum += v < 128 ? v : 256 - v;
  }
  return sum;
}

/**
 * Filters rows of `rowBytes` bytes each: with `adaptive`, the filter that
 * scores best per row (unfiltered rows are tried separately, see
 * deflateRows); otherwise none, which suits palette and packed pixels.
 */
function filterRows(raw: Uint8Array, rowBytes: number, rows: number, bpp: number, adaptive: boolean): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * rows);
  const zero = new Uint8Array(rowBytes);
  for (let y = 0; y < rows; y++) {
    const cur = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : zero;
    let best = 0;
    if (adaptive) {
      let bestCost = Infinity;
      for (let f = 1; f < 5; f++) {
        const c = rowCost(f, cur, prev, bpp, bestCost);
        if (c < bestCost) {
          bestCost = c;
          best = f;
        }
      }
    }
    out[y * (rowBytes + 1)] = best;
    filterRow(best, cur, prev, bpp, out, y * (rowBytes + 1) + 1);
  }
  return out;
}

/** Deflates the rows both unfiltered and filtered and keeps the smaller: flat images often do better unfiltered. */
async function deflateRows(raw: Uint8Array, rowBytes: number, rows: number, bpp: number): Promise<Uint8Array> {
  const [plain, filtered] = await Promise.all([
    zlib(filterRows(raw, rowBytes, rows, bpp, false), "compress"),
    zlib(filterRows(raw, rowBytes, rows, bpp, true), "compress"),
  ]);
  return plain.length <= filtered.length ? plain : filtered;
}

function unfilterRows(data: Uint8Array, rowBytes: number, rows: number, bpp: number): Uint8Array {
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const f = data[y * (rowBytes + 1)];
    const src = y * (rowBytes + 1) + 1;
    const o = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = y > 0 ? out[o - rowBytes + i] : 0;
      const c = y > 0 && i >= bpp ? out[o - rowBytes + i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error("Bad PNG row filter");
      }
      out[o + i] = v & 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding pixels
// ---------------------------------------------------------------------------

/** Number of distinct opaque colours, counting no further than `limit + 1`. */
export function countColors(img: RawImage, limit: number): number {
  const seen = new Set<number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    if (seen.size > limit) break;
  }
  return seen.size;
}

/**
 * Share of horizontal neighbours with exactly the same colour, sampled every
 * 4th row: near 1 for text, shapes and screenshots, low for photos.
 */
export function flatness(img: RawImage): number {
  const { data, width, height } = img;
  let same = 0;
  let total = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] === data[i - 4] && data[i + 1] === data[i - 3] && data[i + 2] === data[i - 2]) same++;
      total++;
    }
  }
  return total ? same / total : 0;
}

/** True when no pixel is even slightly transparent. */
export function isOpaque(img: RawImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

/**
 * RGBA pixels → the smallest lossless form: a packed palette for up to 16
 * colours, greyscale, an 8-bit palette for up to 256, otherwise RGB.
 */
export async function encodeFlate(img: RawImage): Promise<FlateImage> {
  const { width, height, data } = img;
  const n = width * height;
  let gray = true;
  const index = new Map<number, number>();
  let last = -1;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (gray && (r !== g || g !== b)) gray = false;
    const key = (r << 16) | (g << 8) | b;
    if (key === last) continue;
    last = key;
    if (index.size <= 256) {
      if (!index.has(key)) index.set(key, index.size);
    } else if (!gray) break;
  }

  let out: FlateImage;
  if (index.size <= 256 && (index.size <= 16 || !gray)) {
    const bpc = index.size <= 2 ? 1 : index.size <= 4 ? 2 : index.size <= 16 ? 4 : 8;
    const rowBytes = Math.ceil((width * bpc) / 8);
    const raw = new Uint8Array(rowBytes * height);
    const perByte = 8 / bpc;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const v = index.get((data[p] << 16) | (data[p + 1] << 8) | data[p + 2])!;
        const at = y * rowBytes + Math.floor(x / perByte);
        raw[at] |= v << (8 - bpc * ((x % perByte) + 1));
      }
    }
    const palette = new Uint8Array(index.size * 3);
    for (const [key, i] of index) {
      palette[i * 3] = key >> 16;
      palette[i * 3 + 1] = (key >> 8) & 255;
      palette[i * 3 + 2] = key & 255;
    }
    out = {
      width,
      height,
      colors: 1,
      bitsPerComponent: bpc as FlateImage["bitsPerComponent"],
      palette,
      data: await zlib(filterRows(raw, rowBytes, height, 1, false), "compress"),
    };
  } else {
    const colors = gray ? 1 : 3;
    const raw = new Uint8Array(n * colors);
    for (let p = 0, q = 0; p < data.length; p += 4) {
      raw[q++] = data[p];
      if (!gray) {
        raw[q++] = data[p + 1];
        raw[q++] = data[p + 2];
      }
    }
    out = {
      width,
      height,
      colors,
      bitsPerComponent: 8,
      data: await deflateRows(raw, width * colors, height, colors),
    };
  }

  if (!isOpaque(img)) {
    const a = new Uint8Array(n);
    for (let p = 3, q = 0; p < data.length; p += 4) a[q++] = data[p];
    out.alpha = {
      width,
      height,
      colors: 1,
      bitsPerComponent: 8,
      data: await deflateRows(a, width, height, 1),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG files
// ---------------------------------------------------------------------------

export interface PngFile {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
  palette?: Uint8Array;
  /** tRNS chunk: palette alphas, or the one transparent grey/RGB value. */
  transparency?: Uint8Array;
  /** IDAT chunks joined: one zlib stream. */
  idat: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reads a PNG's header and image data, or null when it isn't one. */
export function readPng(bytes: Uint8Array): PngFile | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || sig.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let png: Omit<PngFile, "idat"> | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.length !== length) return null;
    if (type === "IHDR") {
      png = {
        width: view.getUint32(at + 8),
        height: view.getUint32(at + 12),
        bitDepth: bytes[at + 16],
        colorType: bytes[at + 17],
        interlaced: bytes[at + 20] === 1,
      };
    } else if (type === "PLTE" && png) {
      png.palette = body;
    } else if (type === "tRNS" && png) {
      png.transparency = body;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (!png || !idat.length || !(png.colorType in CHANNELS) || !png.width || !png.height) return null;
  const all = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of idat) {
    all.set(c, o);
    o += c.length;
  }
  return { ...png, idat: all };
}

/**
 * The PNG's own compressed data as a PDF image, when a PDF can take it
 * unchanged: no transparency, not interlaced, at most 8 bits per channel.
 */
export function pngAsIs(png: PngFile): FlateImage | null {
  if (png.interlaced || png.bitDepth > 8 || png.transparency) return null;
  if (png.colorType !== 0 && png.colorType !== 2 && png.colorType !== 3) return null;
  if (png.colorType === 3 && (!png.palette || png.palette.length < 3)) return null;
  return {
    width: png.width,
    height: png.height,
    colors: png.colorType === 2 ? 3 : 1,
    bitsPerComponent: png.bitDepth as FlateImage["bitsPerComponent"],
    palette: png.colorType === 3 ? png.palette : undefined,
    data: png.idat,
  };
}

/**
 * PNG → RGBA, for non-interlaced files up to 8 bits per channel (null for
 * others). Throws when the image data is damaged.
 */
export async function decodePng(png: PngFile): Promise<RawImage | null> {
  if (png.interlaced || png.bitDepth > 8) return null;
  const { width, height, bitDepth, colorType } = png;
  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const inflated = await zlib(png.idat, "decompress");
  if (inflated.length < (rowBytes + 1) * height) throw new Error("This image looks damaged.");
  const raw = unfilterRows(inflated, rowBytes, height, Math.max(1, bitsPerPixel >> 3));

  const out = new Uint8ClampedArray(width * height * 4);
  const max = (1 << bitDepth) - 1;
  const sample = (row: number, i: number) => {
    // i-th sample of a row, unpacked to 0..max.
    if (bitDepth === 8) return raw[row + i];
    const bit = i * bitDepth;
    return (raw[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & max;
  };
  const t = png.transparency;
  const tGray = t && colorType === 0 && t.length >= 2 ? (t[0] << 8) | t[1] : -1;
  const tRgb = t && colorType === 2 && t.length >= 6 ? [(t[0] << 8) | t[1], (t[2] << 8) | t[3], (t[4] << 8) | t[5]] : null;
  const pal = png.palette;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const idx = sample(row, x);
        out[o] = pal?.[idx * 3] ?? 0;
        out[o + 1] = pal?.[idx * 3 + 1] ?? 0;
        out[o + 2] = pal?.[idx * 3 + 2] ?? 0;
        out[o + 3] = t && idx < t.length ? t[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const v = sample(row, x * channels);
        const g = Math.round((v * 255) / max);
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = colorType === 4 ? raw[row + x * 2 + 1] : v === tGray ? 0 : 255;
      } else {
        const p = row + x * channels;
        out[o] = raw[p];
        out[o + 1] = raw[p + 1];
        out[o + 2] = raw[p + 2];
        out[o + 3] =
          colorType === 6 ? raw[p + 3] : tRgb && raw[p] === tRgb[0] && raw[p + 1] === tRgb[1] && raw[p + 2] === tRgb[2] ? 0 : 255;
      }
    }
  }
  return { data: out, width, height };
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Wraps an opaque image as a PNG file: its data already is a PNG's IDAT. */
export function flateToPng(img: FlateImage): Uint8Array {
  if (img.alpha) throw new Error("Transparent images aren't supported here.");
  const chunks: [string, Uint8Array][] = [];
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, img.width);
  v.setUint32(4, img.height);
  ihdr[8] = img.bitsPerComponent;
  ihdr[9] = img.palette ? 3 : img.colors === 3 ? 2 : 0;
  chunks.push(["IHDR", ihdr]);
  if (img.palette) chunks.push(["PLTE", img.palette]);
  chunks.push(["IDAT", img.data], ["IEND", new Uint8Array(0)]);
  const total = 8 + chunks.reduce((s, [, d]) => s + 12 + d.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    const typed = new Uint8Array(4 + data.length);
    for (let i = 0; i < 4; i++) typed[i] = type.charCodeAt(i);
    typed.set(data, 4);
    out.set(typed, at + 4);
    view.setUint32(at + 8 + data.length, crc32(typed));
    at += 12 + data.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Into the PDF
// ---------------------------------------------------------------------------

/** Adds the image to the document and returns its reference (draw it with drawOrientedImage). */
export function embedFlate(doc: PDFDocument, img: FlateImage): PDFRef {
  const { context } = doc;
  const colorSpace = img.palette
    ? context.obj([
        PDFName.of("Indexed"),
        PDFName.of("DeviceRGB"),
        img.palette.length / 3 - 1,
        PDFHexString.of(Array.from(img.palette, (b) => b.toString(16).padStart(2, "0")).join("")),
      ])
    : PDFName.of(img.colors === 1 ? "DeviceGray" : "DeviceRGB");
  const dict = context.obj({
    Type: "XObject",
    Subtype: "Image",
    Width: img.width,
    Height: img.height,
    BitsPerComponent: img.bitsPerComponent,
    ColorSpace: colorSpace,
    Filter: "FlateDecode",
    DecodeParms: { Predictor: 15, Colors: img.colors, BitsPerComponent: img.bitsPerComponent, Columns: img.width },
  });
  if (img.alpha) dict.set(PDFName.of("SMask"), embedFlate(doc, img.alpha));
  return context.register(PDFRawStream.of(dict, img.data));
}
