/**
 * A small scanner for PDF content streams. It reports each operator with its
 * operands and steps over strings, arrays, dictionaries, comments and inline
 * image data, so text such as "(Do cm)" or binary image bytes never read as
 * operators.
 */

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

/**
 * Calls `onOp` for every operator in a content stream, in order. Operands are
 * only the simple values directly before it (numbers and names); strings,
 * arrays and dictionaries count as null.
 */
export function scanContent(data: Uint8Array, onOp: (op: string, operands: Operand[]) => void): void {
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
    if (kind === END) return;
    if (kind === OPEN) depth++;
    else if (kind === CLOSE) {
      if (depth && --depth === 0) push(null);
    } else if (kind === NUM || kind === NAME) push(lx.value);
    else if (kind === OTHER) push(null);
    else if (!depth) {
      const word = lx.value as string;
      if (word === "true" || word === "false" || word === "null") push(null);
      else if (word === "BI") {
        lx.pos = skipInlineImage(lx);
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

/** Steps over "BI <dict> ID <data> EI", returning the index just past EI. */
function skipInlineImage(lx: Lexer): number {
  const d = lx.d;
  const entries: Record<string, Operand | Operand[]> = {};
  let key: string | null = null;
  for (;;) {
    const kind = lx.next();
    if (kind === END) return d.length;
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
        if (k === END) return d.length;
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
  const noFilter = filter === undefined || (Array.isArray(filter) && filter.length === 0);
  if (noFilter && w > 0 && h > 0 && bpc > 0 && comps > 0) {
    let i = start + h * Math.ceil((w * comps * bpc) / 8);
    while (i < d.length && WHITESPACE[d[i]]) i++;
    if (d[i] === 0x45 && d[i + 1] === 0x49 && (i + 2 >= d.length || !isRegular(d[i + 2]))) return i + 2;
  }
  return findEndOfImage(d, start);
}

/** Finds "EI" between whitespace that is followed by ordinary operator text. */
function findEndOfImage(d: Uint8Array, start: number): number {
  for (let i = d.indexOf(0x45, start); i >= 0 && i + 1 < d.length; i = d.indexOf(0x45, i + 1)) {
    if (d[i + 1] !== 0x49) continue;
    if (i > start && !WHITESPACE[d[i - 1]]) continue;
    const after = i + 2;
    if (after < d.length && isRegular(d[after])) continue;
    if (looksLikeText(d, after)) return after;
  }
  return d.length;
}

function looksLikeText(d: Uint8Array, from: number): boolean {
  const end = Math.min(d.length, from + 48);
  for (let i = from; i < end; i++) {
    const c = d[i];
    if (c > 0x7e || (c < 0x20 && c !== 9 && c !== 10 && c !== 12 && c !== 13)) return false;
  }
  return true;
}
