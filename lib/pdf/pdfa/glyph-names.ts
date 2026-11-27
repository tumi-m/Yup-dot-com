/**
 * What a simple font's character codes mean: each code's glyph name under
 * the font's encoding, and the letters (Unicode) that name stands for. Used
 * to find the right glyph in a substitute font, and to write the ToUnicode
 * map that keeps the text searchable.
 */
import { StandardFontEmbedder, StandardFonts } from "pdf-lib";

type Table = (string | undefined)[];

/** pdf-lib's own tables (Unicode → [code, name]), turned round to code → name. */
function fromPdfLib(font: StandardFonts): { names: Table; unicode: Map<string, number> } {
  const map = (StandardFontEmbedder.for(font as unknown as Parameters<typeof StandardFontEmbedder.for>[0]).encoding as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings;
  const names: Table = [];
  const unicode = new Map<string, number>();
  for (const [cp, [code, name]] of Object.entries(map)) {
    names[code] ??= name;
    if (!unicode.has(name)) unicode.set(name, Number(cp));
  }
  return { names, unicode };
}

let cache: { win: Table; symbol: Table; dingbats: Table; standard: Table; mac: Table; unicode: Map<string, number> } | null = null;

/** Codes 32–126 of StandardEncoding and MacRomanEncoding (PDF 32000-1, Annex D): ASCII but for two. */
function asciiNames(quote: string, grave: string): Table {
  const t: Table = [];
  const words =
    "space exclam quotedbl numbersign dollar percent ampersand ' parenleft parenright asterisk plus comma hyphen period slash " +
    "zero one two three four five six seven eight nine colon semicolon less equal greater question at";
  words.split(" ").forEach((w, i) => (t[32 + i] = w === "'" ? quote : w));
  for (let i = 0; i < 26; i++) {
    t[65 + i] = String.fromCharCode(65 + i);
    t[97 + i] = String.fromCharCode(97 + i);
  }
  ["bracketleft", "backslash", "bracketright", "asciicircum", "underscore", grave].forEach((w, i) => (t[91 + i] = w));
  ["braceleft", "bar", "braceright", "asciitilde"].forEach((w, i) => (t[123 + i] = w));
  return t;
}

const STANDARD_HIGH: [number, string][] = [
  [161, "exclamdown"], [162, "cent"], [163, "sterling"], [164, "fraction"], [165, "yen"], [166, "florin"], [167, "section"],
  [168, "currency"], [169, "quotesingle"], [170, "quotedblleft"], [171, "guillemotleft"], [172, "guilsinglleft"],
  [173, "guilsinglright"], [174, "fi"], [175, "fl"], [177, "endash"], [178, "dagger"], [179, "daggerdbl"],
  [180, "periodcentered"], [182, "paragraph"], [183, "bullet"], [184, "quotesinglbase"], [185, "quotedblbase"],
  [186, "quotedblright"], [187, "guillemotright"], [188, "ellipsis"], [189, "perthousand"], [191, "questiondown"],
  [193, "grave"], [194, "acute"], [195, "circumflex"], [196, "tilde"], [197, "macron"], [198, "breve"], [199, "dotaccent"],
  [200, "dieresis"], [202, "ring"], [203, "cedilla"], [205, "hungarumlaut"], [206, "ogonek"], [207, "caron"],
  [208, "emdash"], [225, "AE"], [227, "ordfeminine"], [232, "Lslash"], [233, "Oslash"], [234, "OE"], [235, "ordmasculine"],
  [241, "ae"], [245, "dotlessi"], [248, "lslash"], [249, "oslash"], [250, "oe"], [251, "germandbls"],
];

const MAC_HIGH =
  "Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ccedilla " +
  "eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis " +
  "otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls registered " +
  "copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal greaterequal yen mu partialdiff " +
  "summation product pi integral ordfeminine ordmasculine Omega ae oslash questiondown exclamdown logicalnot radical " +
  "florin approxequal Delta guillemotleft guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash " +
  "quotedblleft quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency guilsinglleft " +
  "guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute " +
  "Edieresis Egrave Iacute Icircumflex Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave " +
  "dotlessi circumflex tilde macron breve dotaccent ring cedilla hungarumlaut ogonek caron";

/** Names the standard tables use that pdf-lib's don't cover, and common ones fonts add. */
const MORE_NAMES: Record<string, number> = {
  quotesingle: 0x27, fraction: 0x2044, fi: 0xfb01, fl: 0xfb02, ff: 0xfb00, ffi: 0xfb03, ffl: 0xfb04, dotlessi: 0x131,
  dotlessj: 0x237, Lslash: 0x141, lslash: 0x142, breve: 0x2d8, dotaccent: 0x2d9, ring: 0x2da, hungarumlaut: 0x2dd,
  ogonek: 0x2db, caron: 0x2c7, notequal: 0x2260, infinity: 0x221e, lessequal: 0x2264, greaterequal: 0x2265,
  partialdiff: 0x2202, summation: 0x2211, product: 0x220f, pi: 0x3c0, integral: 0x222b, Omega: 0x2126, radical: 0x221a,
  approxequal: 0x2248, Delta: 0x2206, lozenge: 0x25ca, apple: 0xf8ff, minus: 0x2212, nbspace: 0xa0, nonbreakingspace: 0xa0,
  sfthyphen: 0xad, softhyphen: 0xad, Euro: 0x20ac, mu: 0xb5, periodcentered: 0xb7, middot: 0xb7, Dcroat: 0x110,
  dcroat: 0x111, Dslash: 0x110, Hbar: 0x126, hbar: 0x127, Tbar: 0x166, tbar: 0x167, Eng: 0x14a, eng: 0x14b, IJ: 0x132,
  ij: 0x133, Ldot: 0x13f, ldot: 0x140, napostrophe: 0x149, kgreenlandic: 0x138, longs: 0x17f, Eth: 0xd0, eth: 0xf0,
  Thorn: 0xde, thorn: 0xfe, germandbls: 0xdf, AE: 0xc6, ae: 0xe6, OE: 0x152, oe: 0x153, Oslash: 0xd8, oslash: 0xf8,
  commaaccent: 0x326, figuredash: 0x2012, quotereversed: 0x201b, onethird: 0x2153, twothirds: 0x2154, oneeighth: 0x215b,
  threeeighths: 0x215c, fiveeighths: 0x215d, seveneighths: 0x215e, estimated: 0x212e, afii61352: 0x2116, numero: 0x2116,
  arrowleft: 0x2190, arrowup: 0x2191, arrowright: 0x2192, arrowdown: 0x2193, checkmark: 0x2713, Ohm: 0x2126,
  increment: 0x2206, ellipsis: 0x2026, uni00A0: 0xa0,
};

/** Accents a Latin letter's glyph name can end in, and the marks (code points) each may add. */
const ACCENTS: [string, number[]][] = [
  ["dieresis", [0x308]], ["circumflex", [0x302]], ["hungarumlaut", [0x30b]],
  // A comma accent is a cedilla in Unicode under G, K, L, N and R.
  ["commaaccent", [0x326, 0x327]], ["dotaccent", [0x307]], ["acute", [0x301]], ["grave", [0x300]], ["tilde", [0x303]],
  ["macron", [0x304]], ["breve", [0x306]], ["ring", [0x30a]], ["caron", [0x30c]], ["cedilla", [0x327]], ["ogonek", [0x328]],
];

function tables() {
  if (cache) return cache;
  const win = fromPdfLib(StandardFonts.Helvetica);
  const symbol = fromPdfLib(StandardFonts.Symbol);
  const dingbats = fromPdfLib(StandardFonts.ZapfDingbats);
  const standard = asciiNames("quoteright", "quoteleft");
  for (const [code, name] of STANDARD_HIGH) standard[code] = name;
  const mac = asciiNames("quotesingle", "grave");
  MAC_HIGH.split(" ").forEach((name, i) => (mac[128 + i] = name));
  const unicode = new Map<string, number>([...dingbats.unicode, ...symbol.unicode, ...win.unicode]);
  for (const [name, cp] of Object.entries(MORE_NAMES)) unicode.set(name, cp);
  // WinAnsi's codes above 160 that pdf-lib names after another letter.
  unicode.set("space", 0x20);
  unicode.set("hyphen", 0x2d);
  cache = { win: win.names, symbol: symbol.names, dingbats: dingbats.names, standard, mac, unicode };
  return cache;
}

export type BaseEncoding = "WinAnsiEncoding" | "StandardEncoding" | "MacRomanEncoding" | "Symbol" | "ZapfDingbats";

/** The glyph name of `code` in a base encoding. */
export function baseName(encoding: BaseEncoding, code: number): string | undefined {
  const t = tables();
  const table =
    encoding === "WinAnsiEncoding" ? t.win : encoding === "MacRomanEncoding" ? t.mac : encoding === "Symbol" ? t.symbol : encoding === "ZapfDingbats" ? t.dingbats : t.standard;
  if (encoding === "WinAnsiEncoding") {
    // WinAnsi reads 160 as a space and 173 as a hyphen (PDF 32000-1, D.2).
    if (code === 160) return "space";
    if (code === 173) return "hyphen";
  }
  return table[code];
}

/**
 * The text a glyph name stands for (AGL rules): a standard name, uniXXXX or
 * uXXXX[XX], an accented Latin letter ("Scaron", "aogonek"), a ligature of
 * names joined by "_", and anything after a "." left out. Null when unknown.
 */
export function nameToText(name: string): string | null {
  const base = name.split(".")[0];
  if (!base) return null;
  if (base.includes("_")) {
    const parts = base.split("_").map(nameToText);
    return parts.every((p) => p) ? parts.join("") : null;
  }
  const known = tables().unicode.get(base);
  if (known !== undefined) return String.fromCodePoint(known);
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (m) {
    const cps = m[1].match(/.{4}/g)!.map((h) => parseInt(h, 16));
    return cps.every((cp) => cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(...cps) : null;
  }
  m = /^u([0-9A-F]{4,6})$/.exec(base);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : null;
  }
  if (/^[A-Za-z]$/.test(base)) return base;
  for (const [accent, marks] of ACCENTS) {
    if (base.length <= accent.length || !base.endsWith(accent)) continue;
    const letter = base.slice(0, -accent.length);
    const plain = letter === "dotlessi" ? String.fromCharCode(0x131) : letter === "dotlessj" ? String.fromCharCode(0x237) : /^[A-Za-z]$/.test(letter) ? letter : null;
    if (!plain) continue;
    for (const mark of marks) {
      const joined = (plain + String.fromCharCode(mark)).normalize("NFC");
      if ([...joined].length === 1) return joined;
    }
  }
  return null;
}
