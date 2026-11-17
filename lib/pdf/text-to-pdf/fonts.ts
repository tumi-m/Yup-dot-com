/**
 * The fonts Text and Markdown to PDF write with: Noto Sans and Noto Sans
 * Mono (SIL Open Font License 1.1), embedded so accented Latin, Greek and
 * Cyrillic come out right in any viewer. Each style ships as small files per
 * alphabet (@fontsource's subsets); only those the text uses are fetched and
 * embedded, and only the letters it uses go into the PDF.
 *
 * Letters no file has (Chinese, Japanese, Korean, Arabic, Hebrew, emoji…) are
 * left out and counted, so the result can say so instead of printing boxes.
 */
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

export type Face = "regular" | "bold" | "italic" | "boldItalic" | "mono" | "monoBold";

/** Fetches a font file by name (from /vendor in the browser, node_modules in tests). */
export type FontFiles = (file: string) => Promise<Uint8Array>;

export const NOTO_SANS_VERSION = "5.3.0";
export const NOTO_SANS_MONO_VERSION = "5.3.0";

export const FONT_FAILED = "The font didn't load. Check your connection and try again.";

/** The browser's font files, copied to /vendor by scripts/copy-vendor.mjs. */
export const vendorFonts: FontFiles = async (file) => {
  const dir = file.startsWith("noto-sans-mono-") ? `noto-sans-mono/${NOTO_SANS_MONO_VERSION}` : `noto-sans/${NOTO_SANS_VERSION}`;
  try {
    const res = await fetch(`${globalThis.location?.origin ?? ""}/vendor/${dir}/${file}`);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {
    // Offline or blocked: said below.
  }
  throw new Error(FONT_FAILED);
};

/** The alphabets each file covers, from @fontsource's unicode-range (checked against the glyphs once loaded). */
export const SUBSET_RANGES: [string, [number, number][]][] = [
  ["latin", [[0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc], [0x02c6, 0x02c6], [0x02da, 0x02da], [0x02dc, 0x02dc], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329], [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd]]],
  ["latin-ext", [[0x0100, 0x02ba], [0x02bd, 0x02c5], [0x02c7, 0x02cc], [0x02ce, 0x02d7], [0x02dd, 0x02ff], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329], [0x1d00, 0x1dbf], [0x1e00, 0x1e9f], [0x1ef2, 0x1eff], [0x2020, 0x2020], [0x20a0, 0x20ab], [0x20ad, 0x20c0], [0x2113, 0x2113], [0x2c60, 0x2c7f], [0xa720, 0xa7ff]]],
  ["greek", [[0x0370, 0x0377], [0x037a, 0x037f], [0x0384, 0x038a], [0x038c, 0x038c], [0x038e, 0x03a1], [0x03a3, 0x03ff]]],
  ["greek-ext", [[0x1f00, 0x1fff]]],
  ["cyrillic", [[0x0301, 0x0301], [0x0400, 0x045f], [0x0490, 0x0491], [0x04b0, 0x04b1], [0x2116, 0x2116]]],
  ["cyrillic-ext", [[0x0460, 0x052f], [0x1c80, 0x1c8a], [0x20b4, 0x20b4], [0x2de0, 0x2dff], [0xa640, 0xa69f], [0xfe2e, 0xfe2f]]],
  ["vietnamese", [[0x0102, 0x0103], [0x0110, 0x0111], [0x0128, 0x0129], [0x0168, 0x0169], [0x01a0, 0x01a1], [0x01af, 0x01b0], [0x0300, 0x0301], [0x0303, 0x0304], [0x0308, 0x0309], [0x0323, 0x0323], [0x0329, 0x0329], [0x1ea0, 0x1ef9], [0x20ab, 0x20ab]]],
];

const FILE_STEM: Record<Face, (subset: string) => string> = {
  regular: (s) => `noto-sans-${s}-400-normal.woff`,
  bold: (s) => `noto-sans-${s}-700-normal.woff`,
  italic: (s) => `noto-sans-${s}-400-italic.woff`,
  boldItalic: (s) => `noto-sans-${s}-700-italic.woff`,
  mono: (s) => `noto-sans-mono-${s}-400-normal.woff`,
  monoBold: (s) => `noto-sans-mono-${s}-700-normal.woff`,
};

/** Where a letter a style lacks is looked for next (a Mono file lacks a few signs that Sans has). */
const FALLBACK: Record<Face, Face[]> = {
  regular: [],
  bold: ["regular"],
  italic: ["regular"],
  boldItalic: ["bold", "italic", "regular"],
  mono: ["regular"],
  monoBold: ["mono", "bold", "regular"],
};

type Shaper = { layout(text: string, features?: unknown): { glyphs: unknown[] }; glyphForCodePoint(cp: number): unknown };

/**
 * Letters map straight to their glyphs instead of going through fontkit's
 * shaping, which took most of the time on long files. pdf-lib draws glyphs
 * at their plain widths anyway, and these alphabets need no shaping once
 * the text is NFC with ligatures off. Left as it is if pdf-lib ever changes
 * shape.
 */
function directGlyphs(font: PDFFont) {
  const shaper = (font as unknown as { embedder?: { font?: Shaper } }).embedder?.font;
  if (!shaper || typeof shaper.layout !== "function" || typeof shaper.glyphForCodePoint !== "function") return;
  const cache = new Map<number, unknown>();
  shaper.layout = (text: string) => ({
    glyphs: Array.from(text, (ch) => {
      const cp = ch.codePointAt(0)!;
      let glyph = cache.get(cp);
      if (!glyph) cache.set(cp, (glyph = shaper.glyphForCodePoint(cp)));
      return glyph;
    }),
  });
}

const inRanges =(cp: number, ranges: [number, number][]) => ranges.some(([a, b]) => cp >= a && cp <= b);
const MARK = /\p{M}/u;

interface Loaded {
  file: string;
  glyphs: { hasGlyphForCodePoint(cp: number): boolean; glyphForCodePoint(cp: number): { advanceWidth: number }; unitsPerEm: number };
  font?: PDFFont;
  bytes: Uint8Array;
}

/** A run of text in one font; `font` is null for letters none of the fonts has. */
export interface Run {
  text: string;
  font: Loaded | null;
}

export class FontBook {
  private wanted = new Map<Face, Set<number>>();
  /** The file's own letters, not the page numbers' or list markers'. */
  private own = new Map<Face, Set<number>>();
  private files = new Map<string, Promise<Loaded | null>>();
  /** Per face: code point → the file that draws it (null: none does). */
  private pick = new Map<Face, Map<number, Loaded | null>>();
  private advance = new Map<Loaded, Map<number, number>>();
  /** Letters left out, and a few of them to name. */
  missing = 0;
  missingSample = new Set<string>();

  constructor(private doc: PDFDocument, private load: FontFiles) {
    doc.registerFontkit(fontkit);
  }

  /** Notes that `text` will be written in `face`; call before ready(). */
  need(text: string, face: Face, ownText = true) {
    let set = this.wanted.get(face);
    if (!set) this.wanted.set(face, (set = new Set()));
    let own = this.own.get(face);
    if (!own) this.own.set(face, (own = new Set()));
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      set.add(cp);
      if (ownText) own.add(cp);
    }
  }

  private file(name: string): Promise<Loaded | null> {
    let p = this.files.get(name);
    if (!p) {
      p = this.load(name).then((bytes) => ({ file: name, bytes, glyphs: fontkit.create(bytes) as unknown as Loaded["glyphs"] }));
      this.files.set(name, p);
    }
    return p;
  }

  /** The files of `face` that may hold `cp`, in order. */
  private candidates(face: Face, cp: number): string[] {
    return SUBSET_RANGES.filter(([, ranges]) => inRanges(cp, ranges)).map(([s]) => FILE_STEM[face](s));
  }

  private async resolve(face: Face, cp: number): Promise<Loaded | null> {
    for (const f of [face, ...FALLBACK[face]]) {
      for (const name of this.candidates(f, cp)) {
        const loaded = await this.file(name);
        if (loaded?.glyphs.hasGlyphForCodePoint(cp)) return loaded;
      }
    }
    return null;
  }

  /** Fetches and embeds the files the text needs. */
  async ready() {
    for (const [face, cps] of this.wanted) {
      let map = this.pick.get(face);
      if (!map) this.pick.set(face, (map = new Map()));
      // Latin first: nearly every text needs it, and it settles most letters.
      await this.file(FILE_STEM[face]("latin"));
      const todo = [...cps].filter((cp) => !map!.has(cp));
      const found = await Promise.all(todo.map((cp) => this.resolve(face, cp)));
      todo.forEach((cp, i) => map!.set(cp, found[i]));
    }
    this.wanted.clear();
    // Only files that draw something go into the PDF. Ligatures are off, so
    // a width is the sum of its letters' widths, as measured below.
    for (const p of this.files.values()) {
      const loaded = await p;
      const used = loaded && [...this.pick.values()].some((m) => [...m.values()].includes(loaded));
      if (loaded && used && !loaded.font) {
        loaded.font = await this.doc.embedFont(loaded.bytes, { subset: true, features: { liga: false, clig: false, dlig: false, calt: false } });
        directGlyphs(loaded.font);
      }
    }
  }

  /** Splits `text` into runs of one font each. A combining accent stays with its letter's font when that font has it. */
  runs(text: string, face: Face): Run[] {
    const map = this.pick.get(face);
    const out: Run[] = [];
    let prev: Loaded | null | undefined;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let font = map?.get(cp) ?? null;
      if (prev && font !== prev && MARK.test(ch) && prev.glyphs.hasGlyphForCodePoint(cp)) font = prev;
      const last = out[out.length - 1];
      if (last && last.font === font) last.text += ch;
      else out.push({ text: ch, font });
      prev = font;
    }
    return out;
  }

  /** Width of `text` in points; letters left out take no room. */
  width(text: string, face: Face, size: number): number {
    let units = 0;
    for (const run of this.runs(text, face)) {
      if (!run.font) continue;
      const font = run.font;
      let cache = this.advance.get(font);
      if (!cache) this.advance.set(font, (cache = new Map()));
      let sum = 0;
      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!;
        let w = cache.get(cp);
        if (w === undefined) {
          w = (font.glyphs.glyphForCodePoint(cp).advanceWidth * 1000) / font.glyphs.unitsPerEm;
          cache.set(cp, w);
        }
        sum += w;
      }
      units += sum;
    }
    return (units * size) / 1000;
  }

  /** Distinct visible letters of the file's own text in `face` that some font draws, and a few that none does. */
  coverage(face: Face): { drawable: number; missing: string[] } {
    let drawable = 0;
    const missing: string[] = [];
    const pick = this.pick.get(face);
    for (const cp of this.own.get(face) ?? []) {
      const ch = String.fromCodePoint(cp);
      if (/\s/.test(ch)) continue;
      if (pick?.get(cp)) drawable++;
      else if (missing.length < 3) missing.push(ch);
    }
    return { drawable, missing };
  }

  /** Counts letters a run leaves out, keeping a few to name. */
  dropped(text: string) {
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      this.missing++;
      if (this.missingSample.size < 5) this.missingSample.add(ch);
    }
  }
}
