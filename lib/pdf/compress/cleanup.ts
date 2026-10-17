/**
 * Lossless clean-up: private data, duplicate objects, unreachable objects and
 * streams that could be stored smaller.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import type { PageInfo } from "./placement";
import { LOSSLESS_FILTERS, decodeLossless, deflate, filterChain } from "./streams";

const N = {
  DecodeParms: PDFName.of("DecodeParms"),
  EarlyChange: PDFName.of("EarlyChange"),
  F: PDFName.of("F"),
  Filter: PDFName.of("Filter"),
  FlateDecode: PDFName.of("FlateDecode"),
  Form: PDFName.of("Form"),
  Length: PDFName.of("Length"),
  Metadata: PDFName.of("Metadata"),
  PieceInfo: PDFName.of("PieceInfo"),
  Subtype: PDFName.of("Subtype"),
  Thumb: PDFName.of("Thumb"),
  Type: PDFName.of("Type"),
  XML: PDFName.of("XML"),
};

/** Drops page thumbnails and application-private data (/PieceInfo). */
export function stripPrivateData(context: PDFContext, pages: PageInfo[]) {
  for (const page of pages) {
    page.dict.delete(N.Thumb);
    page.dict.delete(N.PieceInfo);
  }
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && obj.dict.lookup(N.Subtype) === N.Form) obj.dict.delete(N.PieceInfo);
  }
}

/** Stores every stream /Length as a plain number, so old length objects can go. */
export function directLengths(context: PDFContext) {
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) obj.updateDict();
  }
}

function forEachChild(o: PDFObject, fn: (child: PDFObject, set: (v: PDFObject) => void) => void) {
  if (o instanceof PDFStream) o = o.dict;
  if (o instanceof PDFDict) {
    for (const [key, value] of o.entries()) fn(value, (v) => o.set(key, v));
  } else if (o instanceof PDFArray) {
    for (let i = 0; i < o.size(); i++) fn(o.get(i), (v) => o.set(i, v));
  }
}

/** Removes objects that nothing points at (from the catalog or the info dictionary). */
export function dropUnreachable(context: PDFContext): number {
  const reached = new Set<PDFRef>();
  const pending: PDFObject[] = [];
  const { Root, Info } = context.trailerInfo;
  for (const start of [Root, Info]) if (start) pending.push(start);
  while (pending.length) {
    const o = pending.pop()!;
    if (o instanceof PDFRef) {
      if (reached.has(o)) continue;
      reached.add(o);
      const target = context.lookup(o);
      if (target) pending.push(target);
      continue;
    }
    forEachChild(o, (child) => pending.push(child));
  }
  let dropped = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(ref)) {
      context.delete(ref);
      dropped++;
    }
  }
  return dropped;
}

const hashes = new WeakMap<Uint8Array, string>();

/** 2 × 32-bit FNV-1a, enough to bucket candidates before comparing bytes. */
function hash(bytes: Uint8Array): string {
  const known = hashes.get(bytes);
  if (known) return known;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    a = Math.imul(a ^ bytes[i], 0x01000193);
    b = Math.imul(b ^ bytes[i], 0x050c5d1f);
  }
  const h = `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${bytes.length}`;
  hashes.set(bytes, h);
  return h;
}

const SHAREABLE_TYPES = new Set(["Font", "FontDescriptor", "ExtGState", "Encoding"]);
const COLOR_SPACES = new Set(["ICCBased", "Indexed", "Separation", "DeviceN", "CalRGB", "CalGray", "Lab"]);

/**
 * A key for objects that can be shared safely when identical: streams, fonts
 * and similar resources, colour-space and number arrays. Pages, annotations,
 * fields, layers and the like keep their identity.
 */
function shareKey(obj: PDFObject): string | null {
  if (obj instanceof PDFRawStream) {
    const dict = obj.dict.clone();
    dict.delete(N.Length);
    return `s${dict.toString()}#${hash(obj.contents)}`;
  }
  if (obj instanceof PDFDict) {
    const type = obj.get(N.Type);
    return type instanceof PDFName && SHAREABLE_TYPES.has(type.decodeText()) ? `d${obj.toString()}` : null;
  }
  if (obj instanceof PDFArray && obj.size()) {
    const first = obj.get(0);
    const numeric = obj.asArray().every((v) => v instanceof PDFNumber);
    const colorSpace = first instanceof PDFName && COLOR_SPACES.has(first.decodeText());
    return numeric || colorSpace ? `a${obj.toString()}` : null;
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Points every reference to a duplicate at one copy (merged PDFs often carry
 * the same image or font many times). Repeats until nothing changes, since
 * merging streams can make the objects that use them identical too.
 */
export function dedupe(context: PDFContext): number {
  let merged = 0;
  for (let round = 0; round < 6; round++) {
    const first = new Map<string, PDFRef>();
    const replace = new Map<PDFRef, PDFRef>();
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      const key = shareKey(obj);
      if (!key) continue;
      const keep = first.get(key);
      if (!keep) {
        first.set(key, ref);
        continue;
      }
      const other = context.lookup(keep);
      if (obj instanceof PDFRawStream && !(other instanceof PDFRawStream && sameBytes(obj.contents, other.contents))) continue;
      replace.set(ref, keep);
    }
    if (!replace.size) break;
    const swap = (o: PDFObject) =>
      forEachChild(o, (child, set) => {
        if (child instanceof PDFRef) {
          const to = replace.get(child);
          if (to) set(to);
        } else if (child instanceof PDFDict || child instanceof PDFArray) swap(child);
      });
    for (const [, obj] of context.enumerateIndirectObjects()) swap(obj);
    for (const ref of replace.keys()) context.delete(ref);
    merged += replace.size;
  }
  return merged;
}

/**
 * Re-stores streams with Flate at the highest level when that is smaller:
 * unfiltered streams, Flate written at a lower level, and LZW / ASCII85 /
 * ASCIIHex / RunLength (lossless filters that are larger than Flate). A
 * predictor is kept, since the data it describes is unchanged. XMP metadata
 * stays readable as plain text.
 */
export function recompressStreams(context: PDFContext, skip: Set<PDFRef>) {
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || skip.has(ref)) continue;
    const dict = obj.dict;
    if (dict.get(N.Type) === N.Metadata || dict.get(N.Subtype) === N.XML || dict.has(N.F)) continue;
    const chain = filterChain(dict);
    if (!chain) continue;
    if (!chain.names.length) {
      if (dict.has(N.DecodeParms) || obj.contents.length < 64) continue;
      const packed = deflate(obj.contents);
      if (packed.length < obj.contents.length - 16) {
        dict.set(N.Filter, N.FlateDecode);
        context.assign(ref, PDFRawStream.of(dict, packed));
      }
      continue;
    }
    if (!LOSSLESS_FILTERS.has(chain.names[0])) continue;
    const decoded = decodeLossless(context, obj);
    if (!decoded) continue;
    const rest = decoded.rest;
    // A predictor only makes sense on the bytes right below an image codec or at the end.
    if (decoded.predictor && rest.names.length) continue;
    let parms: PDFDict | undefined;
    if (decoded.predictor) {
      parms = decoded.predictor.clone(context);
      parms.delete(N.EarlyChange);
    }
    const options: { bytes: Uint8Array; names: string[]; parms: (PDFDict | undefined)[] }[] = [];
    if (rest.names.length) {
      // Keep the image codec (DCT, JPX, CCITT…), dropping text encodings in front of it.
      options.push({ bytes: decoded.bytes, names: rest.names, parms: rest.parms });
      options.push({ bytes: deflate(decoded.bytes), names: ["FlateDecode", ...rest.names], parms: [undefined, ...rest.parms] });
    } else {
      options.push({ bytes: deflate(decoded.bytes), names: ["FlateDecode"], parms: [parms] });
    }
    const best = options.reduce((a, b) => (b.bytes.length < a.bytes.length ? b : a));
    if (best.bytes.length >= obj.contents.length) continue;
    if (best.names.length === 1) {
      dict.set(N.Filter, PDFName.of(best.names[0]));
      if (best.parms[0]) dict.set(N.DecodeParms, best.parms[0]);
      else dict.delete(N.DecodeParms);
    } else {
      dict.set(N.Filter, context.obj(best.names.map((n) => PDFName.of(n))));
      if (best.parms.some(Boolean)) dict.set(N.DecodeParms, context.obj(best.parms.map((p) => p ?? null)));
      else dict.delete(N.DecodeParms);
    }
    dict.delete(PDFName.of("DP"));
    context.assign(ref, PDFRawStream.of(dict, best.bytes));
  }
}
