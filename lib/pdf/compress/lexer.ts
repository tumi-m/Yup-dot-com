/**
 * A small scanner for PDF content streams. It reports each operator with its
 * operands and steps over strings, arrays, dictionaries, comments and inline
 * image data, so text such as "(Do cm)" or binary image bytes never read as
 * operators.
 */
import { unzlibSync } from "fflate";

/** A number, a name (without the slash), or null for anything else. */
export type Operand = number | string | null;

const WHITESPACE = new Uint8Array(256);
const DELIMITER = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WHITESPACE[c] = 1;
for (const c of "()<>[]{}/%") DELIMITER[c.charCodeAt(0)] = 1;

const isRegular = (c: number) => !WHITESPACE[c] && !DELIMITER[c];

function ascii(d: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) s += String.fromCharCode(d[i]);
  return s;
}

const hexValue = (c: number) =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;

/** Name bytes after the slash, with #xx escapes resolved. */
function nameAt(d: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < to; i++) {
    const c = d[i];
    if (c === 0x23 && i + 2 < to) {
      const hi = hexValue(d[i + 1]);
      const lo = hexValue(d[i + 2]);
      if (hi >= 0 && lo >= 0) {
        s += String.fromCharCode(hi * 16 + lo);
        i += 2;
        continue;
      }
    }
    s += String.fromCharCode(c);
  }
  return s;
}

/** Index just past the literal string that opens at `i`. */
function skipLiteral(d: Uint8Array, i: number): number {
  let depth = 0;
  for (; i < d.length; i++) {
    const c = d[i];
    if (c === 0x5c) i++; // backslash: the next byte is escaped
    else if (c === 0x28) depth++;
    else if (c === 0x29 && --depth === 0) return i + 1;
  }
  return d.length;
}

function skipHex(d: Uint8Array, i: number): number {
  const end = d.indexOf(0x3e, i + 1);
  return end < 0 ? d.length : end + 1;
}

const NUMBER_START = new Uint8Array(256);
for (const c of "0123456789+-.") NUMBER_START[c.charCodeAt(0)] = 1;

// Token kinds.
const NUM = 0;
const NAME = 1;
const WORD = 2;
const OTHER = 3; // a string
const OPEN = 4; // [ or << or {
const CLOSE = 5; // ] or >> or }
const END = 6;

/** Reads one token at a time; `value` holds the number, name or word. */
class Lexer {
  pos = 0;
  /** Where the last token began. */
  start = 0;
  value: number | string = 0;
  constructor(readonly d: Uint8Array) {}

  next(): number {
    const d = this.d;
    const n = d.length;
    let i = this.pos;
    for (;;) {
      while (i < n && WHITESPACE[d[i]]) i++;
      if (i >= n) {
        this.pos = n;
        return END;
      }
      if (d[i] !== 0x25) break;
      while (i < n && d[i] !== 10 && d[i] !== 13) i++; // comment
    }
    this.start = i;
    const c = d[i];
    if (c === 0x28) {
      this.pos = skipLiteral(d, i);
      return OTHER;
    }
    if (c === 0x3c) {
      if (d[i + 1] === 0x3c) {
        this.pos = i + 2;
        return OPEN;
      }
      this.pos = skipHex(d, i);
      return OTHER;
    }
    if (c === 0x3e) {
      this.pos = d[i + 1] === 0x3e ? i + 2 : i + 1;
      return CLOSE;
    }
    if (c === 0x5b || c === 0x7b) {
      this.pos = i + 1;
      return OPEN;
    }
    if (c === 0x5d || c === 0x7d || c === 0x29) {
      this.pos = i + 1;
      return CLOSE;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && isRegular(d[j])) j++;
      this.value = nameAt(d, i + 1, j);
      this.pos = j;
      return NAME;
    }
    let j = i;
    while (j < n && isRegular(d[j])) j++;
    this.pos = j;
    if (NUMBER_START[c]) {
      const v = parseFloat(ascii(d, i, j));
      this.value = Number.isFinite(v) ? v : 0;
      return NUM;
    }
    this.value = ascii(d, i, j);
    return WORD;
  }
}

/** An inline image's dictionary: each value simple, or the simple items of an array. */
export type InlineImageEntries = Record<string, Operand | Operand[]>;

export interface ScanOptions {
  /** Called with each inline image's dictionary, before its data is stepped over. */
  onInlineImage?: (entries: InlineImageEntries) => void;
  /**
   * Also count a stream as unreadable when it ends inside an array or
   * dictionary, or has braces (which content streams never do), since
   * readers may disagree about the operators after them.
   */
  strict?: boolean;
}

/**
 * Calls `onOp` for every operator in a content stream, in order. Operands are
 * only the simple values directly before it (numbers and names); strings,
 * arrays and dictionaries count as null.
 *
 * Returns false when the end of an inline image couldn't be found with
 * confidence; the rest of the stream is then skipped and the operators seen
 * may be incomplete.
 */
export function scanContent(data: Uint8Array, onOp: (op: string, operands: Operand[]) => void, options: ScanOptions = {}): boolean {
  const lx = new Lexer(data);
  let operands: Operand[] = [];
  let depth = 0;
  const push = (v: Operand) => {
    if (depth) return;
    if (operands.length >= 32) operands = operands.slice(-8);
    operands.push(v);
  };
  for (;;) {
    const kind = lx.next();
    if (kind === END) return !(options.strict && depth);
    if (options.strict && (kind === OPEN || kind === CLOSE) && (data[lx.start] === 0x7b || data[lx.start] === 0x7d)) return false;
    if (kind === OPEN) depth++;
    else if (kind === CLOSE) {
      if (depth && --depth === 0) push(null);
    } else if (kind === NUM || kind === NAME) push(lx.value);
    else if (kind === OTHER) push(null);
    else if (!depth) {
      const word = lx.value as string;
      if (word === "true" || word === "false" || word === "null") push(null);
      else if (word === "BI") {
        const end = skipInlineImage(lx, options.onInlineImage);
        if (end < 0) return false;
        lx.pos = end;
        operands = [];
      } else {
        onOp(word, operands);
        operands = [];
      }
    }
  }
}

const COMPONENTS: Record<string, number> = {
  G: 1,
  DeviceGray: 1,
  CalGray: 1,
  RGB: 3,
  DeviceRGB: 3,
  CalRGB: 3,
  CMYK: 4,
  DeviceCMYK: 4,
  I: 1,
  Indexed: 1,
};

const FILTER_NAMES: Record<string, string> = {
  AHx: "ASCIIHexDecode",
  A85: "ASCII85Decode",
  Fl: "FlateDecode",
  RL: "RunLengthDecode",
  DCT: "DCTDecode",
  LZW: "LZWDecode",
  CCF: "CCITTFaxDecode",
};

/** Every operator in PDF 32000 (Table A.1). */
const OPERATORS = new Set(
  (
    "b B b* B* BDC BI BMC BT BX c cm CS cs d d0 d1 Do DP EI EMC ET EX f F f* G g gs h i ID j J K k l m M MP n q Q " +
    "re RG rg ri s S SC sc SCN scn sh T* Tc Td TD Tf Tj TJ TL Tm Tr Ts Tw Tz v w W W* y ' \""
  ).split(" ")
);

/**
 * Steps over "BI <dict> ID <data> EI", returning the index just past EI, or
 * -1 when its end can't be found with confidence.
 */
function skipInlineImage(lx: Lexer, onImage?: (entries: InlineImageEntries) => void): number {
  const d = lx.d;
  const entries: InlineImageEntries = {};
  /** The stream ended inside the dictionary. */
  const cutShort = () => {
    onImage?.(entries);
    return d.length;
  };
  let key: string | null = null;
  for (;;) {
    const kind = lx.next();
    if (kind === END) return cutShort();
    if (kind === WORD && lx.value === "ID") break;
    if (key === null) {
      if (kind === NAME) key = lx.value as string;
      continue;
    }
    if (kind === OPEN) {
      // An array value: keep its first simple item (enough for /CS [/I ...]).
      const items: Operand[] = [];
      let depth = 1;
      while (depth) {
        const k = lx.next();
        if (k === END) return cutShort();
        if (k === OPEN) depth++;
        else if (k === CLOSE) depth--;
        else if (depth === 1 && (k === NAME || k === NUM)) items.push(lx.value);
        else if (depth === 1) items.push(null);
      }
      entries[key] = items;
    } else {
      entries[key] = kind === NUM || kind === NAME ? lx.value : kind === WORD ? (lx.value as string) : null;
    }
    key = null;
  }
  onImage?.(entries);
  // One whitespace byte separates ID from the data.
  const start = lx.pos + 1;

  const num = (a: string, b: string) => {
    const v = entries[a] ?? entries[b];
    return typeof v === "number" ? v : NaN;
  };
  const w = num("W", "Width");
  const h = num("H", "Height");
  const mask = entries.IM ?? entries.ImageMask;
  const filter = entries.F ?? entries.Filter;
  let bpc = num("BPC", "BitsPerComponent");
  let comps = NaN;
  if (mask === "true") {
    comps = 1;
    bpc = 1;
  } else {
    const cs = entries.CS ?? entries.ColorSpace;
    const family = Array.isArray(cs) ? cs[0] : cs;
    if (typeof family === "string") comps = COMPONENTS[family] ?? NaN;
  }
  // The outermost filter decides how the data ends.
  const filters = (Array.isArray(filter) ? filter : filter === undefined ? [] : [filter]).map((f) =>
    typeof f === "string" ? (FILTER_NAMES[f] ?? f) : ""
  );
  const length = num("L", "Length");
  let dataEnd = -1;
  if (length >= 0) dataEnd = start + length;
  else if (!filters.length) {
    if (w > 0 && h > 0 && bpc > 0 && comps > 0) dataEnd = start + h * Math.ceil((w * comps * bpc) / 8);
  } else if (filters[0] === "ASCIIHexDecode") {
    const gt = d.indexOf(0x3e, start);
    if (gt >= 0) dataEnd = gt + 1;
  } else if (filters[0] === "ASCII85Decode") {
    for (let i = d.indexOf(0x7e, start); i >= 0; i = d.indexOf(0x7e, i + 1)) {
      if (d[i + 1] === 0x3e) {
        dataEnd = i + 2;
        break;
      }
    }
  } else if (filters[0] === "DCTDecode") dataEnd = jpegEnd(d, start);
  else if (filters[0] === "RunLengthDecode") dataEnd = runLengthEnd(d, start);
  if (dataEnd >= 0) {
    const end = endMarkerAt(d, dataEnd);
    if (end >= 0) return end;
  }
  return findEndOfImage(d, start, filters[0] === "FlateDecode");
}

/** Index just past an "EI" that follows `i` after optional whitespace, or -1. */
function endMarkerAt(d: Uint8Array, i: number): number {
  while (i < d.length && WHITESPACE[d[i]]) i++;
  return d[i] === 0x45 && d[i + 1] === 0x49 && (i + 2 >= d.length || !isRegular(d[i + 2])) ? i + 2 : -1;
}

/** Index just past a JPEG's end-of-image marker, or -1. */
function jpegEnd(d: Uint8Array, i: number): number {
  if (d[i] !== 0xff || d[i + 1] !== 0xd8) return -1;
  i += 2;
  while (i + 1 < d.length) {
    if (d[i] !== 0xff) {
      i++; // entropy-coded data
      continue;
    }
    const m = d[i + 1];
    if (m === 0xd9) return i + 2;
    if (m === 0xff) i++;
    else if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) i += 2; // stuffing, TEM, restarts
    else if (i + 3 < d.length) i += 2 + ((d[i + 2] << 8) | d[i + 3]);
    else return -1;
  }
  return -1;
}

/** Index just past RunLengthDecode data (its 128 end marker), or -1. */
function runLengthEnd(d: Uint8Array, i: number): number {
  while (i < d.length) {
    const n = d[i];
    if (n === 128) return i + 1;
    i += n < 128 ? n + 2 : 2;
  }
  return -1;
}

/** Start of each "EI" from `start` on with whitespace before it and a delimiter after. */
function* endMarkers(d: Uint8Array, start: number): Generator<number> {
  for (let i = d.indexOf(0x45, start); i >= 0 && i + 1 < d.length; i = d.indexOf(0x45, i + 1)) {
    if (d[i + 1] !== 0x49) continue;
    if (i > start && !WHITESPACE[d[i - 1]]) continue;
    if (i + 2 < d.length && isRegular(d[i + 2])) continue;
    yield i;
  }
}

/**
 * Finds the "EI" that ends image data of unknown length. Flate data is
 * complete only at the real end; otherwise what follows must read as content.
 */
function findEndOfImage(d: Uint8Array, start: number, flate: boolean): number {
  if (flate) {
    let tries = 0;
    for (const i of endMarkers(d, start)) {
      if (++tries > 64) break;
      if (inflates(d.subarray(start, i))) return i + 2;
    }
  }
  for (const i of endMarkers(d, start)) if (followedByContent(d, i + 2)) return i + 2;
  return -1;
}

function inflates(data: Uint8Array): boolean {
  try {
    unzlibSync(data);
    return true;
  } catch {
    return false; // cut short: not the end yet
  }
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** True when the bytes from `from` read as content-stream syntax: operands and known operators. */
function followedByContent(d: Uint8Array, from: number): boolean {
  const lx = new Lexer(d);
  lx.pos = from;
  let ops = 0;
  for (let n = 0; n < 1024; n++) {
    const kind = lx.next();
    if (kind === END) return true;
    if (kind === NUM) {
      if (!NUMBER.test(ascii(d, lx.start, lx.pos))) return false;
    } else if (kind === WORD) {
      const word = lx.value as string;
      if (word === "true" || word === "false" || word === "null") continue;
      if (!OPERATORS.has(word)) return false;
      // Two operators in a row, or the start of the next inline image's data.
      if (++ops === 2 || word === "ID") return true;
    }
  }
  return true;
}
