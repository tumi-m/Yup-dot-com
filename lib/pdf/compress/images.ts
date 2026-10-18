/**
 * Image re-encoding. Each image is resized to what its largest placement
 * needs, then stored the cheapest way that keeps its look: JPEG for photos,
 * lossless Flate (with a PNG predictor, a palette or fewer bits when exact)
 * for flat graphics and soft masks. Anything unusual is left as it is.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { decodeJpeg, encodeJpeg } from "../../image-codec";
import type { PageInfo, Placements } from "./placement";
import { resize } from "./resample";
import { LOSSLESS_FILTERS, decodeFully, decodeLossless, deflate, filterChain, num, predictPng, unpredict } from "./streams";
import { isAbort } from "../../abort";

export interface ImageSettings {
  /** Resolution images are brought down to, in pixels per inch. */
  dpi: number;
  /** MozJPEG quality for photos. */
  quality: number;
  /** Only downsample when an image is this many times sharper than `dpi`. */
  threshold: number;
}

const N = {
  BitsPerComponent: PDFName.of("BitsPerComponent"),
  ColorSpace: PDFName.of("ColorSpace"),
  DCTDecode: PDFName.of("DCTDecode"),
  Decode: PDFName.of("Decode"),
  DecodeParms: PDFName.of("DecodeParms"),
  DeviceGray: PDFName.of("DeviceGray"),
  DeviceRGB: PDFName.of("DeviceRGB"),
  Filter: PDFName.of("Filter"),
  FlateDecode: PDFName.of("FlateDecode"),
  Height: PDFName.of("Height"),
  Image: PDFName.of("Image"),
  ImageMask: PDFName.of("ImageMask"),
  Indexed: PDFName.of("Indexed"),
  Mask: PDFName.of("Mask"),
  Matte: PDFName.of("Matte"),
  SMask: PDFName.of("SMask"),
  SMaskInData: PDFName.of("SMaskInData"),
  Subtype: PDFName.of("Subtype"),
  Width: PDFName.of("Width"),
};

// Photos that are only slightly too sharp aren't worth a generation of loss.
const MIN_GAIN = 0.9;
const MIN_GAIN_JPEG_AGAIN = 0.8;
const MIN_GAIN_LOSSLESS = 0.97;
// Flat graphics (text, lines) blur when resampled, so they keep more pixels.
const FLAT_DPI_FACTOR = 1.5;
const FLAT_THRESHOLD = 1.5;
const TEXT_DPI = 125;
// Larger images would need hundreds of megabytes to decode in a browser tab.
const MAX_PIXELS = 50_000_000;

// ---------------------------------------------------------------------------
// What an image is and whether it's safe to touch
// ---------------------------------------------------------------------------

interface Info {
  width: number;
  height: number;
  comps: 1 | 3;
  jpeg: boolean;
}

const iccKinds = new WeakMap<object, string>();

/** "RGB " or "GRAY" for an ICC profile stream, from its header. */
function iccKind(context: PDFContext, stream: PDFRawStream): string {
  let kind = iccKinds.get(stream);
  if (kind === undefined) {
    const bytes = decodeFully(context, stream);
    kind = bytes && bytes.length >= 20 ? String.fromCharCode(...bytes.subarray(16, 20)) : "";
    iccKinds.set(stream, kind);
  }
  return kind;
}

/** Components of an image colour space we can re-encode (gray or RGB), else 0. */
function colorComponents(context: PDFContext, cs: PDFObject | undefined): 0 | 1 | 3 {
  if (cs === N.DeviceRGB) return 3;
  if (cs === N.DeviceGray) return 1;
  if (!(cs instanceof PDFArray) || cs.size() < 1) return 0;
  const family = cs.lookup(0);
  if (family === PDFName.of("CalRGB")) return 3;
  if (family === PDFName.of("CalGray")) return 1;
  if (family !== PDFName.of("ICCBased")) return 0;
  const profile = cs.lookup(1);
  if (!(profile instanceof PDFRawStream)) return 0;
  const n = num(profile.dict, "N", 0);
  const kind = iccKind(context, profile);
  if (n === 3 && kind === "RGB ") return 3;
  if (n === 1 && kind === "GRAY") return 1;
  return 0;
}

function isDefaultDecode(decode: PDFObject | undefined, comps: number, context: PDFContext): boolean {
  if (decode === undefined) return true;
  if (!(decode instanceof PDFArray) || decode.size() !== comps * 2) return false;
  for (let i = 0; i < decode.size(); i++) {
    const v = context.lookup(decode.get(i));
    if (!(v instanceof PDFNumber) || v.asNumber() !== i % 2) return false;
  }
  return true;
}

/** Checks an image dictionary and its filters, without decoding anything. */
function inspect(context: PDFContext, stream: PDFRawStream): Info | null {
  const d = stream.dict;
  if (d.lookup(N.ImageMask) === PDFBool.True) return null;
  if (d.lookup(N.Mask) instanceof PDFArray) return null; // colour-key masking
  if (d.has(N.SMaskInData)) return null;
  if (num(d, "BitsPerComponent", 0) !== 8) return null;
  const width = num(d, "Width", 0);
  const height = num(d, "Height", 0);
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) return null;
  if (width * height > MAX_PIXELS) return null;
  const comps = colorComponents(context, d.lookup(N.ColorSpace));
  if (!comps) return null;
  if (!isDefaultDecode(d.lookup(N.Decode), comps, context)) return null;
  const chain = filterChain(d);
  if (!chain) return null;
  const last = chain.names.length - 1;
  const jpeg = last >= 0 && chain.names[last] === "DCTDecode";
  for (let i = 0; i < (jpeg ? last : chain.names.length); i++) if (!LOSSLESS_FILTERS.has(chain.names[i])) return null;
  // An explicit colour transform means the JPEG's colours may not be YCbCr.
  if (jpeg && chain.parms[last]?.has(PDFName.of("ColorTransform"))) return null;
  // A soft mask with /Matte holds pre-blended colours; leave the pair alone.
  const smask = d.lookup(N.SMask);
  if (smask instanceof PDFRawStream && smask.dict.has(N.Matte)) return null;
  return { width, height, comps, jpeg };
}

/** A soft mask we can resize and store losslessly: 8-bit gray. */
function inspectMask(context: PDFContext, stream: PDFRawStream): Info | null {
  const info = inspect(context, stream);
  return info && info.comps === 1 && !info.jpeg ? info : null;
}

// ---------------------------------------------------------------------------
// JPEG headers
// ---------------------------------------------------------------------------

interface JpegHeader {
  width: number;
  height: number;
  components: number;
  precision: number;
  /** Sum of the luminance quantisation table: larger means coarser. */
  lumaSum: number;
}

export function jpegHeader(b: Uint8Array): JpegHeader | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let lumaSum = 0;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xdb) {
      // One or more tables: Pq/Tq, then 64 entries of 8 or 16 bits.
      for (let t = i + 4; t < i + 2 + len; ) {
        const wide = b[t] >> 4;
        const id = b[t] & 15;
        let sum = 0;
        for (let k = 0; k < 64; k++) sum += wide ? (b[t + 1 + 2 * k] << 8) | b[t + 2 + 2 * k] : b[t + 1 + k];
        if (id === 0) lumaSum = sum;
        t += 1 + 64 * (wide ? 2 : 1);
      }
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const seg = i + 4;
      return {
        precision: b[seg],
        height: (b[seg + 1] << 8) | b[seg + 2],
        width: (b[seg + 3] << 8) | b[seg + 4],
        components: b[seg + 5],
        lumaSum,
      };
    }
    i += 2 + len;
  }
  return null;
}

/** Neither the JPEG codec nor a browser stand-in could run. */
export class CodecUnavailableError extends Error {
  constructor() {
    super("The image encoder didn't load. Check your connection and try again.");
  }
}

let codecCheck: Promise<void> | null = null;

/** Checks once that JPEGs can be written and read, rather than quietly keeping every image. */
function codecReady(): Promise<void> {
  codecCheck ??= (async () => {
    try {
      const tiny = await encodeJpeg({ data: new Uint8ClampedArray(8 * 8 * 4).fill(128), width: 8, height: 8 }, { quality: 50 });
      await decodeJpeg(tiny);
    } catch {
      codecCheck = null;
      throw new CodecUnavailableError();
    }
  })();
  return codecCheck;
}

const tableSums = new Map<number, number>();

/** Luminance table sum of our encoder at a quality, read from a tiny test encode. */
async function encoderTableSum(quality: number): Promise<number> {
  let sum = tableSums.get(quality);
  if (sum === undefined) {
    const tiny = await encodeJpeg({ data: new Uint8ClampedArray(8 * 8 * 4).fill(128), width: 8, height: 8 }, { quality });
    sum = jpegHeader(tiny)?.lumaSum ?? 0;
    tableSums.set(quality, sum);
  }
  return sum;
}

/**
 * The lowest quality at which our encoder quantises no more coarsely than the
 * source JPEG did. Encoding above it spends bytes on the source's own artefacts.
 */
async function sourceQuality(lumaSum: number): Promise<number> {
  if (!lumaSum) return 100;
  let lo = 1;
  let hi = 100;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await encoderTableSum(mid)) <= lumaSum) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

interface Pixels {
  data: Uint8Array;
  width: number;
  height: number;
  /** 1 (gray), 3 (RGB) or 4 (RGBA from the JPEG decoder; alpha unused). */
  ch: number;
}

async function loadPixels(context: PDFContext, stream: PDFRawStream, info: Info): Promise<{ px: Pixels; lumaSum?: number } | null> {
  const decoded = decodeLossless(context, stream);
  if (!decoded) return null;
  const { width, height, comps } = info;
  if (info.jpeg) {
    if (decoded.predictor) return null;
    const header = jpegHeader(decoded.bytes);
    if (!header || header.precision !== 8 || header.components !== comps) return null;
    if (header.width !== width || header.height !== height) return null;
    const rgba = await decodeJpeg(decoded.bytes);
    if (rgba.width !== width || rgba.height !== height) return null;
    const data = new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.length);
    if (comps === 1) {
      const gray = new Uint8Array(width * height);
      for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4];
      return { px: { data: gray, width, height, ch: 1 }, lumaSum: header.lumaSum };
    }
    return { px: { data, width, height, ch: 4 }, lumaSum: header.lumaSum };
  }
  let bytes: Uint8Array | null = decoded.bytes;
  if (decoded.predictor) {
    const p = decoded.predictor;
    if (num(p, "Colors", 1) !== comps || num(p, "BitsPerComponent", 8) !== 8 || num(p, "Columns", 1) !== width) return null;
    bytes = unpredict(bytes, p, height);
  }
  const size = width * height * comps;
  if (!bytes || bytes.length < size) return null;
  return { px: { data: bytes.length === size ? bytes : bytes.slice(0, size), width, height, ch: comps } };
}

interface Stats {
  /** No colour at all: every pixel has R = G = B. */
  exactGray: boolean;
  /** Colour only from compression noise. */
  nearGray: boolean;
  /** Distinct colours, counted up to 4097. */
  colors: number;
  /** Share of pixels equal to their left neighbour: high for drawings and screenshots. */
  flatness: number;
  /**
   * Pixel-sharp text or line art on a plain background (a screenshot, a chart,
   * a crisp scan), even under JPEG noise. Resampling it costs legibility.
   */
  sharp: boolean;
}

// Colour in any 8×8 block above this (mean channel difference) is real: a
// highlight, a stamp, a signature. Compression noise averages out far below it.
const BLOCK = 8;
const BLOCK_CHROMA = 12;

function analyse(px: Pixels, countColors: boolean): Stats {
  const { data, ch, width, height } = px;
  const n = width * height;
  let colored = 0;
  let strong = 0;
  let chroma = 0;
  let same = 0;
  let colorBlock = false;
  // Steps in brightness to the left neighbour: near zero, edges, and edges done in one pixel.
  let still = 0;
  let edges = 0;
  let hardEdges = 0;
  const seen = new Set<number>();
  // Per block in the current band of rows: sums of R−G and B−G.
  const blocks = Math.ceil(width / BLOCK);
  const rg = new Float64Array(ch === 1 ? 0 : blocks);
  const bg = new Float64Array(ch === 1 ? 0 : blocks);
  let prev = -1;
  let prevY = 0;
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p += ch) {
      let key: number;
      let luma: number;
      if (ch === 1) key = luma = data[p];
      else {
        const r = data[p];
        const g = data[p + 1];
        const b = data[p + 2];
        const diff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
        if (diff) {
          colored++;
          chroma += diff;
          if (diff > 16) strong++;
          const k = (x / BLOCK) | 0;
          rg[k] += r - g;
          bg[k] += b - g;
        }
        key = (r << 16) | (g << 8) | b;
        luma = (r * 77 + g * 150 + b * 29) >> 8;
      }
      if (x) {
        if (key === prev) same++;
        const step = Math.abs(luma - prevY);
        if (step <= 2) still++;
        else if (step >= 32) {
          edges++;
          if (step >= 96) hardEdges++;
        }
      }
      prev = key;
      prevY = luma;
      if (countColors && seen.size <= 4096) seen.add(key);
    }
    if (ch !== 1 && ((y + 1) % BLOCK === 0 || y === height - 1)) {
      const rows = (y % BLOCK) + 1;
      for (let k = 0; k < blocks; k++) {
        const area = rows * (Math.min(width, (k + 1) * BLOCK) - k * BLOCK);
        const mrg = rg[k] / area;
        const mbg = bg[k] / area;
        if (Math.max(Math.abs(mrg), Math.abs(mbg), Math.abs(mrg - mbg)) > BLOCK_CHROMA) colorBlock = true;
      }
      rg.fill(0);
      bg.fill(0);
    }
  }
  const pairs = Math.max(1, n - height);
  return {
    exactGray: colored === 0,
    nearGray: !colorBlock && strong <= n * 0.001 && chroma <= n * 3,
    colors: countColors ? seen.size : 4097,
    flatness: same / pairs,
    // Photos and soft scans step through mid tones; text and lines jump.
    sharp: still >= pairs * 0.6 && edges >= pairs * 0.005 && hardEdges >= edges * 0.25,
  };
}

function toGray(px: Pixels): Pixels {
  if (px.ch === 1) return px;
  const n = px.width * px.height;
  const out = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += px.ch) {
    out[i] = Math.round(0.299 * px.data[p] + 0.587 * px.data[p + 1] + 0.114 * px.data[p + 2]);
  }
  return { data: out, width: px.width, height: px.height, ch: 1 };
}

function scaled(px: Pixels, width: number, height: number): Pixels {
  if (width === px.width && height === px.height) return px;
  return { data: resize(px.data, px.width, px.height, px.ch, width, height), width, height, ch: px.ch };
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

interface Encoded {
  bytes: Uint8Array;
  /** Entries to set on the image dictionary. */
  entries: [PDFName, PDFObject | undefined][];
}

async function toJpeg(context: PDFContext, px: Pixels, quality: number, colorSpace: PDFObject): Promise<Encoded> {
  let rgba: Uint8Array;
  if (px.ch === 4) rgba = px.data;
  else {
    const n = px.width * px.height;
    rgba = new Uint8Array(n * 4);
    for (let i = 0, p = 0; i < n; i++, p += px.ch) {
      const r = px.data[p];
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = px.ch === 1 ? r : px.data[p + 1];
      rgba[i * 4 + 2] = px.ch === 1 ? r : px.data[p + 2];
      rgba[i * 4 + 3] = 255;
    }
  }
  const bytes = await encodeJpeg(
    { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width: px.width, height: px.height },
    { quality, gray: px.ch === 1 }
  );
  // The browser's fallback encoder writes colour JPEGs even for gray pictures.
  const components = jpegHeader(bytes)?.components;
  if (components !== 1 && components !== 3) throw new Error("unexpected JPEG");
  return {
    bytes,
    entries: [
      [N.Filter, N.DCTDecode],
      [N.DecodeParms, undefined],
      [N.ColorSpace, components === 3 && px.ch === 1 ? N.DeviceRGB : colorSpace],
      [N.BitsPerComponent, context.obj(8)],
    ],
  };
}

/** Packs one sample per byte into `bits`-bit samples, row by row. */
function pack(values: Uint8Array, width: number, height: number, bits: number): Uint8Array {
  if (bits === 8) return values;
  const rowBytes = Math.ceil((width * bits) / 8);
  const out = new Uint8Array(rowBytes * height);
  const perByte = 8 / bits;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = values[y * width + x];
      out[y * rowBytes + Math.floor(x / perByte)] |= v << (8 - bits * ((x % perByte) + 1));
    }
  }
  return out;
}

/** Deflates samples, with and without a PNG predictor, keeping the smaller. */
function flate(context: PDFContext, samples: Uint8Array, width: number, height: number, colors: number, bits: number) {
  const rowBytes = Math.ceil((width * colors * bits) / 8);
  const predicted = deflate(predictPng(samples, rowBytes, Math.max(1, (colors * bits) >> 3)));
  // Palettes and few-bit images often do better unfiltered; try when cheap.
  const plain = bits < 8 || samples.length < 4_000_000 ? deflate(samples) : null;
  if (plain && plain.length <= predicted.length) {
    return { bytes: plain, parms: undefined };
  }
  const parms = context.obj({ Predictor: 15, Colors: colors, BitsPerComponent: bits, Columns: width });
  return { bytes: predicted, parms };
}

/** Lossless: fewer bits or a palette when that's exact, otherwise 8-bit with a predictor. */
function toLossless(context: PDFContext, px: Pixels, colorSpace: PDFObject, opts: { mask: boolean }): Encoded {
  const { width, height } = px;
  const n = width * height;
  let ch = px.ch === 4 ? 3 : px.ch;
  let data = px.data;
  let cs: PDFObject = colorSpace;
  if (px.ch === 4) {
    data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) data.set(px.data.subarray(i * 4, i * 4 + 3), i * 3);
  }

  // Gray images whose levels sit on a 1-, 2- or 4-bit grid.
  if (ch === 1) {
    for (const bits of [1, 2, 4]) {
      const step = 255 / ((1 << bits) - 1);
      let exact = true;
      for (let i = 0; i < n && exact; i++) exact = data[i] % step === 0;
      if (!exact) continue;
      const values = new Uint8Array(n);
      for (let i = 0; i < n; i++) values[i] = data[i] / step;
      const f = flate(context, pack(values, width, height, bits), width, height, 1, bits);
      return { bytes: f.bytes, entries: losslessEntries(context, cs, bits, f.parms) };
    }
  }

  // A palette, when there are few colours (soft masks must stay DeviceGray).
  if (!opts.mask) {
    const index = new Map<number, number>();
    const values = new Uint8Array(n);
    let fits = true;
    for (let i = 0; i < n && fits; i++) {
      const key = ch === 1 ? data[i] : (data[i * 3] << 16) | (data[i * 3 + 1] << 8) | data[i * 3 + 2];
      let v = index.get(key);
      if (v === undefined) {
        fits = index.size < 256;
        v = index.size;
        index.set(key, v);
      }
      values[i] = v;
    }
    // For gray, an 8-bit palette is no smaller than the image itself.
    if (fits && index.size <= (ch === 3 ? 256 : 16)) {
      const bits = index.size <= 2 ? 1 : index.size <= 4 ? 2 : index.size <= 16 ? 4 : 8;
      const palette = new Uint8Array(index.size * ch);
      for (const [key, v] of index) {
        if (ch === 1) palette[v] = key;
        else palette.set([key >> 16, (key >> 8) & 255, key & 255], v * 3);
      }
      let hex = "";
      for (const b of palette) hex += b.toString(16).padStart(2, "0");
      cs = context.obj([N.Indexed, cs, index.size - 1, PDFHexString.of(hex)]);
      const f = flate(context, pack(values, width, height, bits), width, height, 1, bits);
      return { bytes: f.bytes, entries: losslessEntries(context, cs, bits, f.parms) };
    }
  }

  const f = flate(context, data, width, height, ch, 8);
  return { bytes: f.bytes, entries: losslessEntries(context, cs, 8, f.parms) };
}

function losslessEntries(context: PDFContext, cs: PDFObject, bits: number, parms: PDFDict | undefined): Encoded["entries"] {
  return [
    [N.Filter, N.FlateDecode],
    [N.DecodeParms, parms],
    [N.ColorSpace, cs],
    [N.BitsPerComponent, context.obj(bits)],
  ];
}

function replaceImage(context: PDFContext, ref: PDFRef, old: PDFRawStream, px: { width: number; height: number }, enc: Encoded) {
  const dict = context.obj({});
  for (const [key, value] of old.dict.entries()) dict.set(key, value);
  dict.delete(N.Decode);
  dict.delete(PDFName.of("DP"));
  dict.set(N.Width, context.obj(px.width));
  dict.set(N.Height, context.obj(px.height));
  for (const [key, value] of enc.entries) {
    if (value === undefined) dict.delete(key);
    else dict.set(key, value);
  }
  const stream = PDFRawStream.of(dict, enc.bytes);
  stream.updateDict();
  context.assign(ref, stream);
}

// ---------------------------------------------------------------------------
// The pass over every image
// ---------------------------------------------------------------------------

export interface ImageReport {
  /** Streams written here (already as small as they get). */
  rewritten: Set<PDFRef>;
  /** Images looked at (not counting soft masks). */
  images: number;
}

/** Finds images referenced from places that weren't walked, and soft-mask owners. */
function uses(context: PDFContext, images: Set<PDFRef>, walked: Set<PDFDict>) {
  const elsewhere = new Set<PDFRef>();
  const maskOwners = new Map<PDFRef, PDFRef[]>();
  const stencils = new Set<PDFRef>();
  const seen = new Set<object>();
  const visit = (o: PDFObject, owner: PDFRef | null) => {
    if (seen.has(o)) return;
    seen.add(o);
    const check = (key: PDFName | null, v: PDFObject, container: PDFDict | PDFArray) => {
      if (v instanceof PDFRef) {
        if (!images.has(v)) return;
        if (owner && key === N.SMask) maskOwners.set(v, [...(maskOwners.get(v) ?? []), owner]);
        else if (owner && key === N.Mask) stencils.add(v);
        else if (!(container instanceof PDFDict && walked.has(container))) elsewhere.add(v);
      } else if (v instanceof PDFDict || v instanceof PDFArray) visit(v, null);
    };
    if (o instanceof PDFDict) for (const [k, v] of o.entries()) check(k, v, o);
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) check(null, o.get(i), o);
  };
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) visit(obj.dict, images.has(ref) ? ref : null);
    else visit(obj, null);
  }
  return { elsewhere, maskOwners, stencils };
}

export async function optimiseImages(
  context: PDFContext,
  pages: PageInfo[],
  placements: Placements,
  settings: ImageSettings,
  /** `done` counts finished images, with a fraction for the one being worked on. */
  progress?: (done: number, total: number) => void
): Promise<ImageReport> {
  const rewritten = new Set<PDFRef>();
  const images = new Set<PDFRef>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(N.Subtype) === N.Image) images.add(ref);
  }
  const { elsewhere, maskOwners, stencils } = uses(context, images, placements.walked);
  const pageMax = Math.max(1, ...pages.map((p) => Math.max(p.width, p.height)));
  const { dpi, quality, threshold } = settings;

  /** The scale (≤ 1 shrinks) that brings an image down to `res` for its largest use. */
  const needed = (ref: PDFRef, w: number, h: number, res = dpi): number => {
    const shown = placements.complete ? placements.shown.get(ref) : undefined;
    let s = shown ? Math.max(((shown.w / 72) * res) / w, ((shown.h / 72) * res) / h) : 0;
    if (!shown || elsewhere.has(ref)) s = Math.max(s, ((pageMax / 72) * res) / Math.max(w, h));
    return s;
  };

  const parents = [...images].filter((r) => !maskOwners.has(r) && !stencils.has(r));
  // How much each soft mask's owners shrank along x and y (1 = an owner kept its size).
  const maskScale = new Map<PDFRef, [number, number]>();
  const ownersLeft = new Map<PDFRef, number>();
  for (const [mask, owners] of maskOwners) ownersLeft.set(mask, owners.length);

  const finishMask = async (mask: PDFRef) => {
    const stream = context.lookup(mask);
    if (!(stream instanceof PDFRawStream) || stencils.has(mask)) return;
    const info = inspectMask(context, stream);
    if (!info) return;
    let [fx, fy] = maskScale.get(mask) ?? [1, 1];
    if (placements.shown.has(mask) || elsewhere.has(mask)) {
      const own = needed(mask, info.width, info.height);
      fx = Math.max(fx, own);
      fy = Math.max(fy, own);
    }
    const loaded = await loadPixels(context, stream, info);
    if (!loaded) return;
    const w = Math.max(1, Math.round(info.width * Math.min(1, fx)));
    const h = Math.max(1, Math.round(info.height * Math.min(1, fy)));
    const px = scaled(loaded.px, w, h);
    const enc = toLossless(context, px, stream.dict.get(N.ColorSpace) ?? N.DeviceGray, { mask: true });
    if (enc.bytes.length < stream.contents.length * (px === loaded.px ? MIN_GAIN_LOSSLESS : 1)) {
      replaceImage(context, mask, stream, px, enc);
      rewritten.add(mask);
    }
  };

  for (let i = 0; i < parents.length; i++) {
    // Each step reports and yields, so the page can show progress between heavy steps.
    const step = async (part: number) => {
      progress?.(i + part, parents.length);
      await new Promise((r) => setTimeout(r, 0));
    };
    await step(0);
    const ref = parents[i];
    let factors: [number, number] = [1, 1];
    try {
      factors = await optimiseOne(ref, step);
    } catch (err) {
      if (err instanceof CodecUnavailableError || isAbort(err)) throw err;
      // A damaged or unusual image stays as it was.
    }
    const stream = context.lookup(ref);
    const mask = stream instanceof PDFRawStream ? stream.dict.get(N.SMask) : undefined;
    if (mask instanceof PDFRef && ownersLeft.has(mask)) {
      const prev = maskScale.get(mask) ?? [0, 0];
      maskScale.set(mask, [Math.max(prev[0], factors[0]), Math.max(prev[1], factors[1])]);
      const left = ownersLeft.get(mask)! - 1;
      ownersLeft.set(mask, left);
      if (left === 0) {
        try {
          await finishMask(mask);
        } catch {
          // keep the mask as it was
        }
      }
    }
  }
  progress?.(parents.length, parents.length);
  return { rewritten, images: parents.length };

  /** Returns how much the image was scaled along x and y ([1, 1] when kept). */
  async function optimiseOne(ref: PDFRef, step: (part: number) => Promise<void>): Promise<[number, number]> {
    const kept: [number, number] = [1, 1];
    const stream = context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return kept;
    const info = inspect(context, stream);
    if (!info) return kept;
    await codecReady();
    const s = needed(ref, info.width, info.height);
    const oldSize = stream.contents.length;
    // Written back as found (often a reference shared with other images).
    const colorSpace = stream.dict.get(N.ColorSpace)!;
    const grayCS = info.comps === 1 ? colorSpace : N.DeviceGray;

    // A JPEG already at the right size and quantised as coarsely as we would
    // only loses quality when re-encoded (unless it turns out to be gray).
    let sourceQ = 100;
    if (info.jpeg) {
      const header = jpegHeader(decodeLossless(context, stream)?.bytes ?? new Uint8Array());
      if (header) sourceQ = await sourceQuality(header.lumaSum);
      if (s * threshold >= 1 && sourceQ <= quality && info.comps === 1) return kept;
    }
    const q = Math.min(quality, sourceQ);

    const loaded = await loadPixels(context, stream, info);
    if (!loaded) return kept;
    const source = loaded.px;
    const stats = analyse(source, !info.jpeg);
    await step(0.35);
    const size = (f: number) => ({
      width: Math.max(1, Math.round(source.width * f)),
      height: Math.max(1, Math.round(source.height * f)),
    });
    const apply = (px: Pixels, enc: Encoded): [number, number] => {
      replaceImage(context, ref, stream, px, enc);
      rewritten.add(ref);
      return [px.width / source.width, px.height / source.height];
    };
    // Resized when well above the preset's resolution. Below TEXT_DPI small type
    // in a picture breaks up, so sharp text and lines stop there (if that still
    // saves more than a few pixels).
    const sj = stats.sharp && dpi < TEXT_DPI ? needed(ref, info.width, info.height, TEXT_DPI) : s;
    const fit = s * threshold < 1 && sj < 0.9 ? sj : 1;
    const photo = async () => {
      const gray = info.comps === 1 || stats.nearGray || stats.exactGray;
      const target = size(fit);
      const px = scaled(gray ? toGray(source) : source, target.width, target.height);
      await step(0.6);
      return { px, enc: await toJpeg(context, px, q, gray ? grayCS : colorSpace) };
    };

    const flat = !info.jpeg && (stats.flatness >= 0.5 || stats.colors <= (info.comps === 3 ? 256 : 32));
    if (flat) {
      const sf = s * FLAT_DPI_FACTOR;
      const target = sf * FLAT_THRESHOLD < 1 ? size(sf) : size(1);
      const px = scaled(stats.exactGray ? toGray(source) : source, target.width, target.height);
      await step(0.6);
      const resized = px !== source && (px.width !== source.width || px.height !== source.height);
      const enc = toLossless(context, px, stats.exactGray ? grayCS : colorSpace, { mask: false });
      // Mostly flat but with photographic parts (a photo on a white page): JPEG may be far
      // smaller. Screenshots, charts and drawings stay lossless: JPEG rings around their edges.
      if (stats.colors > 4096 && !stats.sharp) {
        const alt = await photo();
        if (alt.enc.bytes.length < enc.bytes.length * 0.5 && alt.enc.bytes.length < oldSize * MIN_GAIN) return apply(alt.px, alt.enc);
      }
      if (enc.bytes.length < oldSize * (resized ? MIN_GAIN : MIN_GAIN_LOSSLESS)) return apply(px, enc);
      return kept;
    }

    const resized = fit < 1;
    const regray = info.comps === 3 && (stats.nearGray || stats.exactGray);
    if (info.jpeg && !resized && !regray && sourceQ <= quality) return kept;
    const { px, enc } = await photo();
    const bar = info.jpeg && !resized && !regray ? MIN_GAIN_JPEG_AGAIN : MIN_GAIN;
    if (enc.bytes.length < oldSize * bar) return apply(px, enc);
    if (!info.jpeg) {
      // Not worth a JPEG: at least store it losslessly with a predictor.
      const lossless = toLossless(context, stats.exactGray ? toGray(source) : source, stats.exactGray ? grayCS : colorSpace, { mask: false });
      if (lossless.bytes.length < oldSize * MIN_GAIN_LOSSLESS) return apply(stats.exactGray ? toGray(source) : source, lossless);
    }
    return kept;
  }
}
