/**
 * PDF/A wants every font that draws visible text embedded. A font that
 * isn't (the standard 14, or Arial and Times New Roman named but not
 * included, as many writers leave them) gets a metric-compatible substitute
 * embedded in its place: Arimo for Helvetica and Arial, Tinos for Times,
 * Cousine for Courier (SIL Open Font License 1.1, from @fontsource), only the
 * letters it draws, each as wide as the PDF already makes it. A font whose
 * letters can't be found, or whose substitute's letters differ in width by
 * more than a little, isn't substituted: its pages are drawn as pictures
 * instead (index.ts), and the report names them.
 *
 * Fonts already embedded are left as they are, apart from the small fixes
 * PDF/A asks of them (fixEmbedded).
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream, StandardFontEmbedder, type PDFDocument } from "pdf-lib";
import { baseName, nameToText, type BaseEncoding } from "./glyph-names";
import { TrueTypeFont, writeSubset, type SubsetChar } from "./truetype";
import { numberIn, streamBytes, type FontUse } from "./content";
import { deflate } from "../compress/streams";

const N = PDFName.of;

/** Fetches a substitute font file by name (from /vendor in the browser, node_modules in tests). */
export type FontFiles = (file: string) => Promise<Uint8Array>;

export const SUBSTITUTE_VERSION = "5.3.0";
export const FONT_FAILED = "A font didn't load. Check your connection and try again.";

export type Family = "sans" | "serif" | "mono";
export const FAMILY_FILES: Record<Family, string> = { sans: "arimo", serif: "tinos", mono: "cousine" };
export const FAMILY_NAMES: Record<Family, string> = { sans: "Arimo", serif: "Tinos", mono: "Cousine" };

/** The browser's substitute font files, copied to /vendor by scripts/copy-vendor.mjs. */
export const vendorFonts: FontFiles = async (file) => {
  const family = file.split("-")[0];
  try {
    const res = await fetch(`${globalThis.location?.origin ?? ""}/vendor/${family}/${SUBSTITUTE_VERSION}/${file}`);
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {
    // Offline or blocked: said below.
  }
  throw new Error(FONT_FAILED);
};

/** The alphabets each file covers (@fontsource's unicode-range, the same for the three families). */
export const SUBSETS: [string, [number, number][]][] = [
  ["latin", [[0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc], [0x02c6, 0x02c6], [0x02da, 0x02da], [0x02dc, 0x02dc], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329], [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd]]],
  ["latin-ext", [[0x0100, 0x02ba], [0x02bd, 0x02c5], [0x02c7, 0x02cc], [0x02ce, 0x02d7], [0x02dd, 0x02ff], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329], [0x1d00, 0x1dbf], [0x1e00, 0x1e9f], [0x1ef2, 0x1eff], [0x2020, 0x2020], [0x20a0, 0x20ab], [0x20ad, 0x20c0], [0x2113, 0x2113], [0x2c60, 0x2c7f], [0xa720, 0xa7ff]]],
  ["greek", [[0x0370, 0x0377], [0x037a, 0x037f], [0x0384, 0x038a], [0x038c, 0x038c], [0x038e, 0x03a1], [0x03a3, 0x03ff]]],
  ["greek-ext", [[0x1f00, 0x1fff]]],
  ["cyrillic", [[0x0301, 0x0301], [0x0400, 0x045f], [0x0490, 0x0491], [0x04b0, 0x04b1], [0x2116, 0x2116]]],
  ["cyrillic-ext", [[0x0460, 0x052f], [0x1c80, 0x1c8a], [0x20b4, 0x20b4], [0x2de0, 0x2dff], [0xa640, 0xa69f], [0xfe2e, 0xfe2f]]],
  ["vietnamese", [[0x0102, 0x0103], [0x0110, 0x0111], [0x0128, 0x0129], [0x0168, 0x0169], [0x01a0, 0x01a1], [0x01af, 0x01b0], [0x0300, 0x0301], [0x0303, 0x0304], [0x0308, 0x0309], [0x0323, 0x0323], [0x0329, 0x0329], [0x1ea0, 0x1ef9], [0x20ab, 0x20ab]]],
  ["hebrew", [[0x0307, 0x0308], [0x0590, 0x05ff], [0x200c, 0x2010], [0x20aa, 0x20aa], [0x25cc, 0x25cc], [0xfb1d, 0xfb4f]]],
];

/**
 * How far a substitute letter's own width may be from the width the PDF
 * gives it, in 1/1000 of the font size, before the substitute counts as a
 * different font. The PDF's widths are kept either way; past this, letters
 * would visibly crowd or gap.
 */
export const WIDTH_TOLERANCE = 50;

const STANDARD_14 = new Set([
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic",
  "Times-BoldItalic", "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique", "Symbol", "ZapfDingbats",
]);

/** A font's name without its subset tag ("ABCDEF+"). */
export function plainName(dict: PDFDict): string {
  const base = dict.lookup(N("BaseFont"));
  return base instanceof PDFName ? base.decodeText().replace(/^[A-Z]{6}\+/, "") : "";
}

export function isStandard14(dict: PDFDict): boolean {
  return STANDARD_14.has(plainName(dict));
}

export function descriptorOf(font: PDFDict): PDFDict | undefined {
  let d = font;
  if (font.lookup(N("Subtype")) === N("Type0")) {
    const kids = font.lookup(N("DescendantFonts"));
    const kid = kids instanceof PDFArray ? kids.lookup(0) : undefined;
    if (!(kid instanceof PDFDict)) return undefined;
    d = kid;
  }
  const fd = d.lookup(N("FontDescriptor"));
  return fd instanceof PDFDict ? fd : undefined;
}

/** True when the font's program is in the file (Type 3 glyphs always are). */
export function isEmbedded(font: PDFDict): boolean {
  if (font.lookup(N("Subtype")) === N("Type3")) return true;
  const fd = descriptorOf(font);
  return !!fd && ["FontFile", "FontFile2", "FontFile3"].some((k) => fd.lookup(N(k)) instanceof PDFStream);
}

/** Style of a font, from its name and descriptor. */
export function styleOf(font: PDFDict): { family: Family; bold: boolean; italic: boolean } {
  const name = plainName(font).toLowerCase();
  const fd = descriptorOf(font);
  const flags = numberIn(fd, "Flags", 0);
  const mono = /courier|mono|consol|typewriter|cousine|fixed|lucidaconsole/.test(name) || (!!(flags & 1) && !/sans|arial|helvetica/.test(name));
  const serif =
    !mono &&
    (/times|roman|serif|tinos|georgia|garamond|cambria|minion|palatino|century|bookman|caslon|baskerville/.test(name.replace(/sans/g, "")) ||
      (!!(flags & 2) && !/sans|arial|helvetica|grotesk|gothic/.test(name)));
  const bold = /bold|black|heavy|semibold|demi/.test(name) || !!(flags & (1 << 18)) || numberIn(fd, "FontWeight", 400) >= 600;
  const italic = /italic|oblique|slanted|kursiv/.test(name) || !!(flags & 64) || numberIn(fd, "ItalicAngle", 0) !== 0;
  return { family: mono ? "mono" : serif ? "serif" : "sans", bold, italic };
}

/** The standard font whose metrics a font without widths is read with (as readers do). */
function metricsFont(font: PDFDict): string {
  const plain = plainName(font);
  if (STANDARD_14.has(plain)) return plain;
  if (plain === "Symbol" || /symbol/i.test(plain)) return "Symbol";
  const { family, bold, italic } = styleOf(font);
  if (family === "serif") return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  const base = family === "mono" ? "Courier" : "Helvetica";
  return `${base}${bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""}`;
}

/** Each code's glyph name under the font's encoding (PDF 32000-1, 9.6.6). */
export function encodingOf(font: PDFDict): (code: number) => string | undefined {
  const plain = plainName(font);
  const symbolic = !!(numberIn(descriptorOf(font), "Flags", 0) & 4);
  const builtIn: BaseEncoding | null =
    plain === "Symbol" ? "Symbol" : plain === "ZapfDingbats" ? "ZapfDingbats" : symbolic && !STANDARD_14.has(plain) ? null : "StandardEncoding";
  const enc = font.lookup(N("Encoding"));
  let base: BaseEncoding | null = builtIn;
  const differences = new Map<number, string>();
  const named = (n: PDFName | undefined): BaseEncoding | null => {
    const v = n?.decodeText();
    return v === "WinAnsiEncoding" || v === "MacRomanEncoding" || v === "StandardEncoding" ? v : null;
  };
  if (enc instanceof PDFName) base = named(enc) ?? base;
  else if (enc instanceof PDFDict) {
    const b = enc.lookup(N("BaseEncoding"));
    if (b instanceof PDFName) base = named(b) ?? base;
    const diffs = enc.lookup(N("Differences"));
    if (diffs instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diffs.size(); i++) {
        const v = diffs.lookup(i);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) differences.set(code++, v.decodeText());
      }
    }
  }
  return (code) => differences.get(code) ?? (base ? baseName(base, code) : undefined);
}

/** Code → text from a ToUnicode CMap (one-byte codes), for codes the encoding doesn't name. */
export function readToUnicode(font: PDFDict): Map<number, string> {
  const out = new Map<number, string>();
  const stream = font.lookup(N("ToUnicode"));
  if (!(stream instanceof PDFStream)) return out;
  const bytes = streamBytes(stream);
  if (!bytes) return out;
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const utf16 = (hex: string) => {
    const units: number[] = [];
    for (let i = 0; i + 3 < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      const code = parseInt(m[1], 16);
      if (code <= 255) out.set(code, utf16(m[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(255, parseInt(m[2], 16));
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => utf16(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) out.set(c, items[c - lo]);
      } else {
        const start = utf16(m[3].slice(1, -1));
        if (!start) continue;
        const last = start.charCodeAt(start.length - 1);
        for (let c = lo; c <= hi; c++) out.set(c, start.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return out;
}

/** The width the PDF draws `code` with, in 1/1000 of the font size, or null when it gives none. */
function pdfWidth(font: PDFDict, code: number, glyph: string | undefined): number | null {
  const widths = font.lookup(N("Widths"));
  if (widths instanceof PDFArray) {
    const first = numberIn(font, "FirstChar", 0);
    const w = widths.lookup(code - first);
    if (w instanceof PDFNumber) return w.asNumber();
    return numberIn(descriptorOf(font), "MissingWidth", 0);
  }
  if (!glyph) return null;
  const w = StandardFontEmbedder.for(metricsFont(font) as Parameters<typeof StandardFontEmbedder.for>[0]).font.getWidthOfGlyph(glyph);
  return typeof w === "number" ? w : null;
}

/** Loads each substitute file once. */
export class SubstituteFiles {
  private files = new Map<string, Promise<TrueTypeFont | null>>();
  constructor(private load: FontFiles) {}

  private file(name: string): Promise<TrueTypeFont | null> {
    let p = this.files.get(name);
    if (!p) {
      p = this.load(name).then((bytes) => TrueTypeFont.from(bytes));
      this.files.set(name, p);
    }
    return p;
  }

  /** The glyph(s) drawing `text` in one file of the style: one glyph, or the letters of a ligature such as "fi". */
  async glyphsFor(family: Family, bold: boolean, italic: boolean, text: string): Promise<{ font: TrueTypeFont; parts: number[] } | null> {
    const style = `${bold ? 700 : 400}-${italic ? "italic" : "normal"}`;
    // As it is, composed, or as its parts (a ligature such as "fi" as f and i).
    const tries = [text, text.normalize("NFC"), text.normalize("NFKD")];
    for (const t of new Set(tries)) {
      const cps = [...t].map((ch) => ch.codePointAt(0)!);
      if (!cps.length || cps.length > 3) continue;
      for (const [subset, ranges] of SUBSETS) {
        if (!cps.every((cp) => ranges.some(([a, b]) => cp >= a && cp <= b) || cp === 0x20)) continue;
        const font = await this.file(`${FAMILY_FILES[family]}-${subset}-${style}.woff`);
        if (!font) continue;
        const parts = cps.map((cp) => font.glyphFor(cp));
        if (parts.every((g) => g > 0)) return { font, parts };
      }
    }
    return null;
  }
}

/** Six capital letters from the font and its codes, as subset fonts are named. */
function subsetTag(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7919;
  }
  return tag;
}

/** A ToUnicode CMap for one-byte codes. */
export function toUnicodeCMap(map: Map<number, string>): Uint8Array {
  const entries = [...map].filter(([, t]) => t.length).sort((a, b) => a[0] - b[0]);
  const hex = (t: string) => {
    let out = "";
    for (let i = 0; i < t.length; i++) out += t.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
    return out;
  };
  const lines = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<00> <FF>",
    "endcodespacerange",
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [code, text] of chunk) lines.push(`<${code.toString(16).padStart(2, "0").toUpperCase()}> <${hex(text)}>`);
    lines.push("endbfchar");
  }
  lines.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end");
  return Uint8Array.from(lines.join("\n"), (c) => c.charCodeAt(0));
}

export interface Substitution {
  /** The font's name in the PDF. */
  from: string;
  /** The substitute's name. */
  to: string;
}

/**
 * Embeds a substitute for one font, in place. Returns what it became, or
 * null (nothing changed) when the substitute can't stand in for it.
 */
export async function substitute(doc: PDFDocument, use: FontUse, files: SubstituteFiles): Promise<Substitution | null> {
  const font = use.dict;
  const subtype = font.lookup(N("Subtype"));
  if (use.composite || !(subtype === N("Type1") || subtype === N("MMType1") || subtype === N("TrueType"))) return null;
  const { family, bold, italic } = styleOf(font);
  const nameOf = encodingOf(font);
  const unicode = readToUnicode(font);
  const codes = [...new Set([...use.shown, ...use.hidden])].sort((a, b) => a - b);
  if (!codes.length) return null;
  const chars: SubsetChar[] = [];
  const texts = new Map<number, string>();
  for (const code of codes) {
    const glyph = nameOf(code);
    const named = glyph && glyph !== ".notdef" ? nameToText(glyph) : null;
    const text = named ?? unicode.get(code) ?? null;
    if (!text) return null;
    const found = await files.glyphsFor(family, bold, italic, text);
    if (!found) return null;
    const natural = (found.parts.reduce((n, g) => n + found.font.advance(g), 0) * 1000) / found.font.unitsPerEm;
    const given = pdfWidth(font, code, glyph);
    // Letters drawn invisibly (OCR text) only need to be there.
    if (given !== null && use.shown.has(code) && Math.abs(given - natural) > WIDTH_TOLERANCE) return null;
    chars.push({ code, parts: found.parts, font: found.font, width: given ?? natural });
    texts.set(code, unicode.get(code) ?? text);
  }
  if (new Set(chars.map((c) => c.font.unitsPerEm)).size > 1) return null;

  const from = plainName(font) || "an unnamed font";
  const to = `${FAMILY_NAMES[family]}${bold || italic ? "-" : ""}${bold ? "Bold" : ""}${italic ? "Italic" : ""}`;
  const name = `${subsetTag(`${plainName(font)}|${codes.join(",")}`)}+${to}`;
  const program = writeSubset(chars, name);
  const ctx = doc.context;
  const fontFile = ctx.register(ctx.flateStream(program, { Length1: program.length }));
  const m = chars[0].font.metrics;
  const scale = 1000 / chars[0].font.unitsPerEm;
  const flags = 4 | (family === "mono" ? 1 : 0) | (family === "serif" ? 2 : 0) | (italic ? 64 : 0);
  const descriptor = ctx.obj({
    Type: "FontDescriptor",
    FontName: name,
    Flags: flags,
    FontBBox: m.bbox.map((v) => Math.round(v * scale)),
    ItalicAngle: Math.round(m.italicAngle * 10) / 10,
    Ascent: Math.round(m.ascent * scale),
    Descent: Math.round(m.descent * scale),
    CapHeight: Math.round(m.capHeight * scale),
    StemV: bold ? 140 : 80,
    FontFile2: fontFile,
  });

  const first = codes[0];
  const last = codes[codes.length - 1];
  const byCode = new Map(chars.map((c) => [c.code, c.width]));
  const widths: number[] = [];
  for (let c = first; c <= last; c++) widths.push(Math.round((byCode.get(c) ?? 0) * 1000) / 1000);

  font.set(N("Subtype"), N("TrueType"));
  font.set(N("BaseFont"), N(name));
  font.set(N("FirstChar"), PDFNumber.of(first));
  font.set(N("LastChar"), PDFNumber.of(last));
  font.set(N("Widths"), ctx.obj(widths));
  font.set(N("FontDescriptor"), ctx.register(descriptor));
  // A symbolic TrueType font maps codes through its own cmap: no Encoding (PDF/A 6.2.11.6).
  font.delete(N("Encoding"));
  font.set(N("ToUnicode"), ctx.register(ctx.flateStream(toUnicodeCMap(texts))));
  return { from, to };
}

/** Composite fonts' CMaps PDF/A accepts without embedding (PDF 32000-1, Table 118). */
const PREDEFINED_CMAPS = new Set(
  (
    "Identity-H Identity-V GB-EUC-H GB-EUC-V GBpc-EUC-H GBpc-EUC-V GBK-EUC-H GBK-EUC-V GBKp-EUC-H GBKp-EUC-V GBK2K-H GBK2K-V " +
    "UniGB-UCS2-H UniGB-UCS2-V UniGB-UTF16-H UniGB-UTF16-V B5pc-H B5pc-V HKscs-B5-H HKscs-B5-V ETen-B5-H ETen-B5-V ETenms-B5-H " +
    "ETenms-B5-V CNS-EUC-H CNS-EUC-V UniCNS-UCS2-H UniCNS-UCS2-V UniCNS-UTF16-H UniCNS-UTF16-V 83pv-RKSJ-H 90ms-RKSJ-H " +
    "90ms-RKSJ-V 90msp-RKSJ-H 90msp-RKSJ-V 90pv-RKSJ-H Add-RKSJ-H Add-RKSJ-V EUC-H EUC-V Ext-RKSJ-H Ext-RKSJ-V H V UniJIS-UCS2-H " +
    "UniJIS-UCS2-V UniJIS-UCS2-HW-H UniJIS-UCS2-HW-V UniJIS-UTF16-H UniJIS-UTF16-V KSC-EUC-H KSC-EUC-V KSCms-UHC-H KSCms-UHC-V " +
    "KSCms-UHC-HW-H KSCms-UHC-HW-V KSCpc-EUC-H UniKS-UCS2-H UniKS-UCS2-V UniKS-UTF16-H UniKS-UTF16-V"
  ).split(" ")
);

/**
 * The small fixes PDF/A asks of a font that is embedded, or that only draws
 * invisible text. False when it can't be accepted as it is (its pages then
 * become pictures).
 */
export function fixInPlace(font: PDFDict): boolean {
  const ctx = font.context;
  if (font.lookup(N("Type")) !== N("Font")) font.set(N("Type"), N("Font"));
  const fd = descriptorOf(font);
  // Optional lists of a subset's glyphs, often wrong: PDF/A-2 checks them when present.
  fd?.delete(N("CharSet"));
  fd?.delete(N("CIDSet"));
  const subtype = font.lookup(N("Subtype"));
  if (subtype === N("Type0")) {
    const enc = font.lookup(N("Encoding"));
    if (enc instanceof PDFName && !PREDEFINED_CMAPS.has(enc.decodeText())) return false;
    const kids = font.lookup(N("DescendantFonts"));
    const kid = kids instanceof PDFArray ? kids.lookup(0) : undefined;
    if (kid instanceof PDFDict && kid.lookup(N("Subtype")) === N("CIDFontType2") && isEmbedded(font) && !kid.has(N("CIDToGIDMap"))) {
      // Identity is what readers assume when it is left out.
      kid.set(N("CIDToGIDMap"), N("Identity"));
    }
    const sub = fd?.lookup(N("FontFile3"));
    if (sub instanceof PDFStream && !["CIDFontType0C", "OpenType"].includes((sub.dict.lookup(N("Subtype")) as PDFName | undefined)?.decodeText() ?? "")) return false;
    return true;
  }
  if (subtype === N("Type3")) return true;
  const ff3 = fd?.lookup(N("FontFile3"));
  if (ff3 instanceof PDFStream && !["Type1C", "OpenType"].includes((ff3.dict.lookup(N("Subtype")) as PDFName | undefined)?.decodeText() ?? "")) return false;
  // Widths must have one entry per code from FirstChar to LastChar.
  const widths = font.lookup(N("Widths"));
  const first = font.lookup(N("FirstChar"));
  const last = font.lookup(N("LastChar"));
  if (widths instanceof PDFArray && first instanceof PDFNumber && last instanceof PDFNumber) {
    const want = last.asNumber() - first.asNumber() + 1;
    if (want > 0 && widths.size() !== want) {
      const missing = numberIn(fd, "MissingWidth", 0);
      const list: number[] = [];
      for (let i = 0; i < want; i++) {
        const w = widths.lookup(i);
        list.push(w instanceof PDFNumber ? w.asNumber() : missing);
      }
      font.set(N("Widths"), ctx.obj(list));
    }
    return true;
  }
  // Widths are optional only for the standard 14 fonts.
  return isStandard14(font);
}
