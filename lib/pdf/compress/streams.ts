/**
 * Stream filters: decoding the common lossless filters, PNG/TIFF predictors,
 * and Flate encoding at the highest level.
 */
import { unzlibSync, inflateSync, zlibSync } from "fflate";
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, type PDFContext } from "pdf-lib";

export const LOSSLESS_FILTERS = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"]);

export interface FilterChain {
  names: string[];
  parms: (PDFDict | undefined)[];
}

/** The stream's filters in decoding order, or null if they are malformed. */
export function filterChain(dict: PDFDict): FilterChain | null {
  const filter = dict.lookup(PDFName.of("Filter"));
  const parms = dict.lookup(PDFName.of("DecodeParms")) ?? dict.lookup(PDFName.of("DP"));
  const names: string[] = [];
  const list: (PDFDict | undefined)[] = [];
  if (filter === undefined) return { names, parms: list };
  if (filter instanceof PDFName) {
    names.push(filter.decodeText());
    list.push(parms instanceof PDFDict ? parms : undefined);
    return { names, parms: list };
  }
  if (!(filter instanceof PDFArray)) return null;
  for (let i = 0; i < filter.size(); i++) {
    const f = filter.lookup(i);
    if (!(f instanceof PDFName)) return null;
    names.push(f.decodeText());
    const p = parms instanceof PDFArray ? parms.lookup(i) : i === 0 ? parms : undefined;
    list.push(p instanceof PDFDict ? p : undefined);
  }
  return { names, parms: list };
}

export function num(dict: PDFDict | undefined, key: string, fallback: number): number {
  const v = dict?.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/** zlib/deflate data → bytes. Tolerates a missing or broken zlib header. */
export function inflate(data: Uint8Array): Uint8Array | null {
  try {
    return unzlibSync(data);
  } catch {
    // fall through
  }
  try {
    return inflateSync(data);
  } catch {
    return null;
  }
}

/** Bytes → zlib data at the highest compression level. */
export function deflate(data: Uint8Array): Uint8Array {
  return zlibSync(data, { level: 9 });
}

/**
 * Decodes one lossless filter (not undoing predictors). Damaged Flate data is
 * only accepted when `tolerant`: a partial result is fine for reading content,
 * never for re-storing it.
 */
function decodeOne(context: PDFContext, name: string, data: Uint8Array, parms: PDFDict | undefined, tolerant: boolean): Uint8Array | null {
  if (name === "FlateDecode") {
    const out = inflate(data);
    if (out || !tolerant) return out;
  }
  try {
    const dict = context.obj({ Filter: name });
    if (parms) dict.set(PDFName.of("DecodeParms"), parms);
    return decodePDFRawStream(PDFRawStream.of(dict, data)).decode();
  } catch {
    return null;
  }
}

export interface Decoded {
  bytes: Uint8Array;
  /** Filters still applied to `bytes` (an image codec such as DCTDecode), with their parameters. */
  rest: FilterChain;
  /** Predictor parameters of the last lossless filter that was removed. */
  predictor?: PDFDict;
}

/**
 * Removes the stream's leading lossless filters, stopping at the first one it
 * can't decode (DCTDecode, JPXDecode, Crypt…). Returns null on damaged data.
 * Predictors are not undone; `predictor` says which parameters apply.
 */
export function decodeLossless(context: PDFContext, stream: PDFRawStream, tolerant = false): Decoded | null {
  const chain = filterChain(stream.dict);
  if (!chain) return null;
  let bytes = stream.contents;
  let i = 0;
  let predictor: PDFDict | undefined;
  for (; i < chain.names.length && LOSSLESS_FILTERS.has(chain.names[i]); i++) {
    if (predictor) return null; // a predictor in the middle of a chain: leave it alone
    const parms = chain.parms[i];
    const out = decodeOne(context, chain.names[i], bytes, parms, tolerant);
    if (!out) return null;
    bytes = out;
    if (parms && num(parms, "Predictor", 1) > 1) predictor = parms;
  }
  return { bytes, rest: { names: chain.names.slice(i), parms: chain.parms.slice(i) }, predictor };
}

/** Readable bytes of a stream with only lossless filters (content streams, forms, ICC profiles). */
export function decodeFully(context: PDFContext, stream: PDFRawStream): Uint8Array | null {
  const d = decodeLossless(context, stream, true);
  if (!d || d.rest.names.length) return null;
  if (!d.predictor) return d.bytes;
  return unpredict(d.bytes, d.predictor);
}

/**
 * Undoes a PNG (10–15) or TIFF (2) predictor. The image's pixels follow, row by
 * row. Returns null when the data is shorter than its rows or the predictor is
 * unknown.
 */
export function unpredict(data: Uint8Array, parms: PDFDict, rows = Infinity): Uint8Array | null {
  const predictor = num(parms, "Predictor", 1);
  const colors = num(parms, "Colors", 1);
  const bpc = num(parms, "BitsPerComponent", 8);
  const columns = num(parms, "Columns", 1);
  if (predictor <= 1) return data;
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  if (!(rowBytes > 0)) return null;
  if (predictor === 2) {
    if (bpc !== 8) return null;
    const out = data.slice();
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes) {
      for (let i = r + bpp; i < r + rowBytes; i++) out[i] = (out[i] + out[i - bpp]) & 255;
    }
    return out;
  }
  if (predictor < 10) return null;
  const count = Math.min(rows, Math.floor(data.length / (rowBytes + 1)));
  const out = new Uint8Array(count * rowBytes);
  for (let r = 0; r < count; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const o = r * rowBytes;
    const up = o - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = r ? out[up + i] : 0;
      let v: number;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + a;
          break;
        case 2:
          v = x + b;
          break;
        case 3:
          v = x + ((a + b) >> 1);
          break;
        case 4: {
          const c = i >= bpp && r ? out[up + i - bpp] : 0;
          v = x + paeth(a, b, c);
          break;
        }
        default:
          return null;
      }
      out[o + i] = v & 255;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * PNG-style prediction with a filter chosen per row (the smallest sum of
 * absolute differences, as libpng does). Pair with /Predictor 15.
 */
export function predictPng(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
  const rows = Math.floor(data.length / rowBytes);
  const out = new Uint8Array(rows * (rowBytes + 1));
  const trial = new Uint8Array(rowBytes);
  const best = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const o = r * rowBytes;
    let bestType = 0;
    let bestCost = Infinity;
    for (let type = 0; type < 5; type++) {
      if (r === 0 && (type === 2 || type === 4)) continue;
      let cost = 0;
      for (let i = 0; i < rowBytes; i++) {
        const x = data[o + i];
        const a = i >= bpp ? data[o + i - bpp] : 0;
        const b = r ? data[o - rowBytes + i] : 0;
        let v: number;
        if (type === 0) v = x;
        else if (type === 1) v = x - a;
        else if (type === 2) v = x - b;
        else if (type === 3) v = x - ((a + b) >> 1);
        else v = x - paeth(a, b, i >= bpp && r ? data[o - rowBytes + i - bpp] : 0);
        v &= 255;
        trial[i] = v;
        cost += v < 128 ? v : 256 - v;
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = type;
        best.set(trial);
      }
    }
    out[r * (rowBytes + 1)] = bestType;
    out.set(best, r * (rowBytes + 1) + 1);
  }
  return out;
}
