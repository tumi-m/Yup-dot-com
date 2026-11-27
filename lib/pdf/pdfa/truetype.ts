/**
 * Just enough TrueType for PDF/A font substitution: reads a font (a .ttf, or
 * a WOFF 1 file as @fontsource ships them), finds glyphs and their widths,
 * and writes a small font of only the glyphs a PDF uses.
 *
 * The font written is a "symbolic" TrueType font: its cmap maps the PDF's own
 * character codes (and 0xF000 plus each code) straight to glyphs, so the
 * page's text needs no change and no glyph names. Each glyph's advance is the
 * width the PDF already uses, so text stays exactly where it was and the
 * widths in the font and in the PDF agree (PDF/A 6.2.11.5). Hinting is left
 * out: viewers draw unhinted TrueType well, and glyphs from different files
 * of one family can then share a font.
 */
import { unzlibSync } from "fflate";

const u16 = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];
const i16 = (d: Uint8Array, o: number) => {
  const v = u16(d, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (d: Uint8Array, o: number) => ((d[o] << 24) >>> 0) + ((d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]);
const tagAt = (d: Uint8Array, o: number) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);

/** The tables of a .ttf or WOFF 1 font, uncompressed; null when it is neither. */
export function readTables(bytes: Uint8Array): Map<string, Uint8Array> | null {
  const tables = new Map<string, Uint8Array>();
  if (bytes.length < 12) return null;
  const sig = tagAt(bytes, 0);
  try {
    if (sig === "wOFF") {
      const count = u16(bytes, 12);
      for (let i = 0; i < count; i++) {
        const at = 44 + 20 * i;
        const tag = tagAt(bytes, at);
        const offset = u32(bytes, at + 4);
        const compLength = u32(bytes, at + 8);
        const origLength = u32(bytes, at + 12);
        const raw = bytes.subarray(offset, offset + compLength);
        tables.set(tag, compLength < origLength ? unzlibSync(raw) : raw.slice());
      }
      return tables;
    }
    if (sig === "\0\x01\0\0" || sig === "true") {
      const count = u16(bytes, 4);
      for (let i = 0; i < count; i++) {
        const at = 12 + 16 * i;
        const offset = u32(bytes, at + 8);
        tables.set(tagAt(bytes, at), bytes.subarray(offset, offset + u32(bytes, at + 12)));
      }
      return tables;
    }
  } catch {
    return null;
  }
  return null;
}

/** A TrueType font's glyphs, widths and cmap, from readTables. */
export class TrueTypeFont {
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  private readonly loca: number[];
  private readonly hMetrics: number;
  private readonly unicode = new Map<number, number>();
  /** Code to glyph from a (3,0) symbol cmap, keyed by its code with 0xF000 taken off. */
  private readonly symbol = new Map<number, number>();

  private constructor(readonly tables: Map<string, Uint8Array>) {
    const head = tables.get("head")!;
    const maxp = tables.get("maxp")!;
    const hhea = tables.get("hhea")!;
    this.unitsPerEm = u16(head, 18) || 1000;
    this.numGlyphs = u16(maxp, 4);
    this.hMetrics = u16(hhea, 34);
    const loca = tables.get("loca")!;
    const long = i16(head, 50) === 1;
    this.loca = [];
    for (let i = 0; i <= this.numGlyphs; i++) this.loca.push(long ? u32(loca, i * 4) : u16(loca, i * 2) * 2);
    this.readCmap(tables.get("cmap"));
  }

  static from(bytes: Uint8Array): TrueTypeFont | null {
    const tables = readTables(bytes);
    if (!tables || !["head", "hhea", "hmtx", "maxp", "loca", "glyf"].every((t) => tables.has(t))) return null;
    try {
      return new TrueTypeFont(tables);
    } catch {
      return null;
    }
  }

  private readCmap(cmap: Uint8Array | undefined) {
    if (!cmap) return;
    const count = u16(cmap, 2);
    for (let i = 0; i < count; i++) {
      const platform = u16(cmap, 4 + 8 * i);
      const encoding = u16(cmap, 6 + 8 * i);
      const offset = u32(cmap, 8 + 8 * i);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      const symbol = platform === 3 && encoding === 0;
      if (!unicode && !symbol) continue;
      const into = symbol ? this.symbol : this.unicode;
      const format = u16(cmap, offset);
      if (format === 4) readFormat4(cmap, offset, into);
      else if (format === 12) readFormat12(cmap, offset, into);
    }
    for (const [code, gid] of [...this.symbol]) {
      if (code >= 0xf000 && code <= 0xf0ff) this.symbol.set(code - 0xf000, gid);
    }
  }

  /** The glyph for a Unicode code point, or 0 (.notdef) when the font has none. */
  glyphFor(cp: number): number {
    return this.unicode.get(cp) ?? 0;
  }

  /** The glyph a (3,0) symbol cmap gives a one-byte code, or 0. */
  symbolGlyph(code: number): number {
    return this.symbol.get(code) ?? 0;
  }

  get hasUnicodeCmap(): boolean {
    return this.unicode.size > 0;
  }

  /** Advance width in font units. */
  advance(gid: number): number {
    const hmtx = this.tables.get("hmtx")!;
    const i = Math.min(gid, this.hMetrics - 1);
    return u16(hmtx, i * 4);
  }

  /** Raw glyph data (empty for a glyph with no outline). */
  glyph(gid: number): Uint8Array {
    if (gid < 0 || gid >= this.numGlyphs) return new Uint8Array(0);
    return this.tables.get("glyf")!.subarray(this.loca[gid], this.loca[gid + 1]);
  }

  /** Vertical metrics and style, in font units, for the PDF font descriptor. */
  get metrics() {
    const head = this.tables.get("head")!;
    const hhea = this.tables.get("hhea")!;
    const os2 = this.tables.get("OS/2");
    const post = this.tables.get("post");
    return {
      bbox: [i16(head, 36), i16(head, 38), i16(head, 40), i16(head, 42)] as [number, number, number, number],
      ascent: i16(hhea, 4),
      descent: i16(hhea, 6),
      capHeight: os2 && u16(os2, 0) >= 2 && os2.length >= 90 ? i16(os2, 88) : Math.round(i16(hhea, 4) * 0.7),
      weight: os2 ? u16(os2, 4) : 400,
      italicAngle: post ? i16(post, 4) + u16(post, 6) / 65536 : 0,
      fixedPitch: post ? u32(post, 12) !== 0 : false,
    };
  }

  /** The font's own name records (copyright, licence) to keep in a subset. */
  nameRecord(id: number): string | null {
    const name = this.tables.get("name");
    if (!name) return null;
    const count = u16(name, 2);
    const strings = u16(name, 4);
    for (let i = 0; i < count; i++) {
      const at = 6 + 12 * i;
      if (u16(name, at) !== 3 || u16(name, at + 2) !== 1 || u16(name, at + 6) !== id) continue;
      const length = u16(name, at + 8);
      const offset = strings + u16(name, at + 10);
      let s = "";
      for (let k = 0; k + 1 < length; k += 2) s += String.fromCharCode(u16(name, offset + k));
      return s;
    }
    return null;
  }
}

function readFormat4(cmap: Uint8Array, at: number, into: Map<number, number>) {
  const segX2 = u16(cmap, at + 6);
  const ends = at + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  for (let s = 0; s < segX2; s += 2) {
    const end = u16(cmap, ends + s);
    const start = u16(cmap, starts + s);
    const delta = u16(cmap, deltas + s);
    const range = u16(cmap, ranges + s);
    if (start > end) continue;
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let gid: number;
      if (!range) gid = (c + delta) & 0xffff;
      else {
        const p = ranges + s + range + (c - start) * 2;
        if (p + 1 >= cmap.length) break;
        gid = u16(cmap, p);
        if (gid) gid = (gid + delta) & 0xffff;
      }
      if (gid && !into.has(c)) into.set(c, gid);
    }
  }
}

function readFormat12(cmap: Uint8Array, at: number, into: Map<number, number>) {
  const groups = u32(cmap, at + 12);
  for (let g = 0; g < groups; g++) {
    const p = at + 16 + g * 12;
    const start = u32(cmap, p);
    const end = u32(cmap, p + 4);
    const first = u32(cmap, p + 8);
    // Only the Basic Multilingual Plane and a little more: a PDF's simple font has 256 codes.
    for (let c = start; c <= end && c - start < 0x10000; c++) if (!into.has(c)) into.set(c, first + (c - start));
  }
}

// ---------------------------------------------------------------------------
// Writing a subset
// ---------------------------------------------------------------------------

/** One character code of the new font: the glyphs it draws (several for a ligature such as "fi") and its width. */
export interface SubsetChar {
  code: number;
  /** Glyphs of `font`, placed one after another at their own advances. */
  parts: number[];
  font: TrueTypeFont;
  /** The width the PDF uses for this code, in 1/1000 of the font size. */
  width: number;
}

class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 255);
  }
  u16(v: number) {
    this.bytes.push((v >> 8) & 255, v & 255);
  }
  u32(v: number) {
    this.bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  }
  raw(d: Uint8Array | number[]) {
    for (const b of d) this.bytes.push(b);
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

const COMPOSITE_MORE = 0x20;
const COMPOSITE_WORDS = 0x01;
const COMPOSITE_XY = 0x02;
const COMPOSITE_SCALE = 0x08;
const COMPOSITE_XY_SCALE = 0x40;
const COMPOSITE_2X2 = 0x80;
const COMPOSITE_INSTRUCTIONS = 0x100;

/** A glyph's data without its hinting instructions, components renumbered by `renumber`. */
function plainGlyph(data: Uint8Array, renumber: (gid: number) => number): Uint8Array {
  if (data.length < 10) return new Uint8Array(0);
  const contours = i16(data, 0);
  if (contours >= 0) {
    const insAt = 10 + contours * 2;
    const insLength = u16(data, insAt);
    const out = new Uint8Array(data.length - insLength);
    out.set(data.subarray(0, insAt));
    // No instructions: length 0, then the flags and points as they were.
    out.set(data.subarray(insAt + 2 + insLength), insAt + 2);
    return out;
  }
  const out = data.slice();
  let p = 10;
  for (;;) {
    const flags = u16(out, p);
    const gid = renumber(u16(out, p + 2));
    out[p + 2] = gid >> 8;
    out[p + 3] = gid & 255;
    let next = p + 4 + (flags & COMPOSITE_WORDS ? 4 : 2);
    if (flags & COMPOSITE_SCALE) next += 2;
    else if (flags & COMPOSITE_XY_SCALE) next += 4;
    else if (flags & COMPOSITE_2X2) next += 8;
    if (!(flags & COMPOSITE_MORE)) {
      const cleared = flags & ~COMPOSITE_INSTRUCTIONS;
      out[p] = cleared >> 8;
      out[p + 1] = cleared & 255;
      return out.subarray(0, next);
    }
    p = next;
  }
}

/** The glyphs a composite glyph is built from. */
function componentsOf(data: Uint8Array): number[] {
  if (data.length < 10 || i16(data, 0) >= 0) return [];
  const out: number[] = [];
  let p = 10;
  for (let n = 0; n < 64 && p + 4 <= data.length; n++) {
    const flags = u16(data, p);
    out.push(u16(data, p + 2));
    let next = p + 4 + (flags & COMPOSITE_WORDS ? 4 : 2);
    if (flags & COMPOSITE_SCALE) next += 2;
    else if (flags & COMPOSITE_XY_SCALE) next += 4;
    else if (flags & COMPOSITE_2X2) next += 8;
    if (!(flags & COMPOSITE_MORE)) break;
    p = next;
  }
  return out;
}

/** A composite glyph drawing `parts` side by side, each moved right by its `dx`. */
function joinedGlyph(parts: { gid: number; dx: number; bbox: number[] }[]): Uint8Array {
  const w = new Writer();
  const boxes = parts.filter((p) => p.bbox.length === 4);
  const edge = (pick: (p: (typeof boxes)[number]) => number, f: (...v: number[]) => number) => (boxes.length ? f(...boxes.map(pick)) : 0);
  w.u16(0xffff); // numberOfContours -1: composite
  for (const v of [
    edge((p) => p.bbox[0] + p.dx, Math.min),
    edge((p) => p.bbox[1], Math.min),
    edge((p) => p.bbox[2] + p.dx, Math.max),
    edge((p) => p.bbox[3], Math.max),
  ])
    w.u16(v & 0xffff);
  parts.forEach((part, i) => {
    w.u16(COMPOSITE_WORDS | COMPOSITE_XY | (i < parts.length - 1 ? COMPOSITE_MORE : 0));
    w.u16(part.gid);
    w.u16(part.dx & 0xffff);
    w.u16(0);
  });
  return w.done();
}

const bboxOf = (data: Uint8Array) => (data.length >= 10 ? [i16(data, 2), i16(data, 4), i16(data, 6), i16(data, 8)] : []);

function checksum(d: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum = (sum + (((d[i] << 24) | ((d[i + 1] ?? 0) << 16) | ((d[i + 2] ?? 0) << 8) | (d[i + 3] ?? 0)) >>> 0)) >>> 0;
  return sum;
}

function nameTable(records: [number, string][]): Uint8Array {
  const w = new Writer();
  const strings = new Writer();
  w.u16(0);
  w.u16(records.length);
  w.u16(6 + records.length * 12);
  for (const [id, text] of records) {
    const start = strings.bytes.length;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      strings.u16(cp > 0xffff ? 0xfffd : cp);
    }
    w.u16(3);
    w.u16(1);
    w.u16(0x409);
    w.u16(id);
    w.u16(strings.bytes.length - start);
    w.u16(start);
  }
  w.raw(strings.bytes);
  return w.done();
}

/** A (3,0) format 4 cmap: each code and 0xF000 plus it, to its glyph. */
function symbolCmap(map: Map<number, number>): Uint8Array {
  const codes = [...map.keys()].sort((a, b) => a - b);
  const all = [...codes, ...codes.map((c) => 0xf000 + c)];
  const gidOf = (c: number) => map.get(c >= 0xf000 ? c - 0xf000 : c)!;
  // Runs of consecutive codes, each read through glyphIdArray.
  const segments: { start: number; end: number }[] = [];
  for (const c of all) {
    const last = segments[segments.length - 1];
    if (last && c === last.end + 1) last.end = c;
    else segments.push({ start: c, end: c });
  }
  segments.push({ start: 0xffff, end: 0xffff });
  const n = segments.length;
  const glyphs: number[] = [];
  const offsets: number[] = [];
  segments.forEach((s, i) => {
    if (s.start === 0xffff) {
      offsets.push(0);
      return;
    }
    // From this entry of idRangeOffset to the segment's first glyph in glyphIdArray.
    offsets.push((n - i + glyphs.length) * 2);
    for (let c = s.start; c <= s.end; c++) glyphs.push(gidOf(c));
  });
  const sub = new Writer();
  const length = 16 + n * 8 + glyphs.length * 2;
  const pow = 2 ** Math.floor(Math.log2(n));
  sub.u16(4);
  sub.u16(length);
  sub.u16(0);
  sub.u16(n * 2);
  sub.u16(pow * 2);
  sub.u16(Math.log2(pow));
  sub.u16(n * 2 - pow * 2);
  for (const s of segments) sub.u16(s.end);
  sub.u16(0);
  for (const s of segments) sub.u16(s.start);
  for (const s of segments) sub.u16(s.start === 0xffff ? 1 : 0);
  for (const o of offsets) sub.u16(o);
  for (const g of glyphs) sub.u16(g);
  const w = new Writer();
  w.u16(0);
  w.u16(1);
  w.u16(3);
  w.u16(0);
  w.u32(12);
  w.raw(sub.bytes);
  return w.done();
}

/**
 * A symbolic TrueType font of `chars`, named `postscriptName`. Glyphs come
 * from their own font (files of one family share units per em); the first
 * font's other tables (head, hhea, OS/2, its copyright and licence) are kept.
 */
export function writeSubset(chars: SubsetChar[], postscriptName: string): Uint8Array {
  const base = chars[0].font;
  const upem = base.unitsPerEm;
  // New glyph numbers: .notdef first, then one per code, then the glyphs those are built from.
  const glyphs: { font: TrueTypeFont; gid: number; data: Uint8Array | null; advance: number }[] = [
    { font: base, gid: 0, data: null, advance: base.advance(0) },
  ];
  const index = new Map<TrueTypeFont, Map<number, number>>();
  const need = (font: TrueTypeFont, gid: number): number => {
    let map = index.get(font);
    if (!map) index.set(font, (map = new Map()));
    let n = map.get(gid);
    if (n === undefined) {
      n = glyphs.length;
      map.set(gid, n);
      glyphs.push({ font, gid, data: null, advance: font.advance(gid) });
      for (const c of componentsOf(font.glyph(gid))) need(font, c);
    }
    return n;
  };
  index.set(base, new Map([[0, 0]]));
  for (const c of componentsOf(base.glyph(0))) need(base, c);

  const cmap = new Map<number, number>();
  for (const ch of chars) {
    const advance = Math.round((ch.width * upem) / 1000);
    if (ch.parts.length === 1) {
      // Its own glyph number, so its advance can be the PDF's width.
      const n = glyphs.length;
      glyphs.push({ font: ch.font, gid: ch.parts[0], data: null, advance });
      for (const c of componentsOf(ch.font.glyph(ch.parts[0]))) need(ch.font, c);
      cmap.set(ch.code, n);
      continue;
    }
    let dx = 0;
    const parts = ch.parts.map((gid) => {
      const part = { gid: need(ch.font, gid), dx, bbox: bboxOf(ch.font.glyph(gid)) };
      dx += ch.font.advance(gid);
      return part;
    });
    cmap.set(ch.code, glyphs.length);
    glyphs.push({ font: ch.font, gid: -1, data: joinedGlyph(parts), advance });
  }

  const glyf = new Writer();
  const loca: number[] = [];
  const hmtx = new Writer();
  let maxAdvance = 0;
  for (const g of glyphs) {
    loca.push(glyf.bytes.length);
    const map = index.get(g.font)!;
    const data = g.data ?? plainGlyph(g.font.glyph(g.gid), (c) => map.get(c) ?? 0);
    glyf.raw(data);
    while (glyf.bytes.length % 4) glyf.u8(0);
    const advance = Math.max(0, Math.min(0xffff, g.advance));
    maxAdvance = Math.max(maxAdvance, advance);
    hmtx.u16(advance);
    hmtx.u16(bboxOf(data)[0] ?? 0);
  }
  loca.push(glyf.bytes.length);
  const locaW = new Writer();
  for (const o of loca) locaW.u32(o);

  const head = base.tables.get("head")!.slice(0, 54);
  head.set([0, 0, 0, 0], 8); // checkSumAdjustment, set below
  head[50] = 0;
  head[51] = 1; // long loca
  const hhea = base.tables.get("hhea")!.slice(0, 36);
  hhea[10] = maxAdvance >> 8;
  hhea[11] = maxAdvance & 255;
  hhea[34] = glyphs.length >> 8;
  hhea[35] = glyphs.length & 255;
  const maxpSrc = base.tables.get("maxp")!;
  const maxp = maxpSrc.slice(0, u32(maxpSrc, 0) === 0x00010000 ? 32 : 6);
  maxp[4] = glyphs.length >> 8;
  maxp[5] = glyphs.length & 255;
  if (maxp.length === 32 && chars.some((c) => c.parts.length > 1)) {
    // A ligature built here is one level above glyphs that may be composites themselves.
    const parts = Math.max(u16(maxp, 28), ...chars.map((c) => c.parts.length));
    const depth = Math.max(u16(maxp, 30), 2);
    maxp.set([parts >> 8, parts & 255, depth >> 8, depth & 255], 28);
  }
  const post = new Writer();
  const postSrc = base.tables.get("post");
  post.u32(0x00030000);
  post.raw(postSrc ? postSrc.subarray(4, 16) : new Uint8Array(12));
  post.raw(new Uint8Array(16));
  const family = postscriptName.replace(/^[A-Z]{6}\+/, "");
  const names: [number, string][] = [];
  const copyright = base.nameRecord(0);
  if (copyright) names.push([0, copyright]);
  names.push([1, family], [2, "Regular"], [3, postscriptName], [4, family], [6, postscriptName.replace(/[^\x21-\x7e]|[[\](){}<>/%]/g, "")]);
  for (const id of [13, 14]) {
    const text = base.nameRecord(id);
    if (text) names.push([id, text]);
  }

  const tables: [string, Uint8Array][] = [
    ["OS/2", base.tables.get("OS/2") ?? new Uint8Array(0)],
    ["cmap", symbolCmap(cmap)],
    ["glyf", glyf.done()],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx.done()],
    ["loca", locaW.done()],
    ["maxp", maxp],
    ["name", nameTable(names)],
    ["post", post.done()],
  ].filter(([, t]) => (t as Uint8Array).length > 0) as [string, Uint8Array][];
  return assemble(tables);
}

/** Puts tables (sorted by tag) into one font file, with checksums. */
function assemble(tables: [string, Uint8Array][]): Uint8Array {
  tables.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const n = tables.length;
  const pow = 2 ** Math.floor(Math.log2(n));
  const w = new Writer();
  w.u32(0x00010000);
  w.u16(n);
  w.u16(pow * 16);
  w.u16(Math.log2(pow));
  w.u16(n * 16 - pow * 16);
  let offset = 12 + n * 16;
  const placed: number[] = [];
  for (const [tag, data] of tables) {
    for (const ch of tag) w.u8(ch.charCodeAt(0));
    w.u32(checksum(data));
    w.u32(offset);
    w.u32(data.length);
    placed.push(offset);
    offset += (data.length + 3) & ~3;
  }
  for (const [, data] of tables) {
    w.raw(data);
    while (w.bytes.length % 4) w.u8(0);
  }
  const out = w.done();
  const headAt = placed[tables.findIndex(([tag]) => tag === "head")];
  if (headAt !== undefined) {
    const adjust = (0xb1b0afba - checksum(out)) >>> 0;
    out[headAt + 8] = adjust >>> 24;
    out[headAt + 9] = (adjust >>> 16) & 255;
    out[headAt + 10] = (adjust >>> 8) & 255;
    out[headAt + 11] = adjust & 255;
  }
  return out;
}
