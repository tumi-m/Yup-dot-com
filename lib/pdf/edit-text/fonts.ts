import type { Family, RunFont } from "./types";

/**
 * Which font new words are drawn in. The run's own font only when the file
 * carries all of it (not a subset) as a TrueType or OpenType program with
 * every letter typed, in the same weight and slant; otherwise the closest of
 * the standard PDF fonts, and Noto Sans for letters those can't draw. Plain
 * code with no imports, so the editor can say what will be used before the
 * file is written.
 */

/** pdf-lib's names for the twelve standard fonts this picks from. */
export type StandardName =
  | "Helvetica"
  | "Helvetica-Bold"
  | "Helvetica-Oblique"
  | "Helvetica-BoldOblique"
  | "Times-Roman"
  | "Times-Bold"
  | "Times-Italic"
  | "Times-BoldItalic"
  | "Courier"
  | "Courier-Bold"
  | "Courier-Oblique"
  | "Courier-BoldOblique";

export function standardFont(family: Family, bold: boolean, italic: boolean): StandardName {
  if (family === "serif") return bold && italic ? "Times-BoldItalic" : bold ? "Times-Bold" : italic ? "Times-Italic" : "Times-Roman";
  const base = family === "mono" ? "Courier" : "Helvetica";
  return `${base}${bold && italic ? "-BoldOblique" : bold ? "-Bold" : italic ? "-Oblique" : ""}` as StandardName;
}

/** A font's name for people: no subset prefix, words apart ("Helvetica-Bold" → "Helvetica Bold"). */
export function fontLabel(name: string): string {
  const plain = name.replace(/^[A-Z]{6}\+/, "").replace(/-(Identity|UniGB|UniJIS|UniKS|UniCNS)-.*$/, "");
  if (plain === "Times-Roman") return "Times";
  return plain
    .replace(/[-_,]+/g, " ")
    .replace(/MT$|PSMT$|PS$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim() || "the original font";
}

/** The CSS font the editor shows new words in, close to what the file will use. */
export function cssFamily(family: Family): string {
  if (family === "serif") return '"Times New Roman", Times, "Liberation Serif", serif';
  if (family === "mono") return '"Courier New", Courier, "Liberation Mono", monospace';
  return 'Helvetica, Arial, "Liberation Sans", "Noto Sans", sans-serif';
}

/** Where a line of `family` text has its baseline, in ems from the top of a CSS line box `lineHeight` ems tall. */
export function cssBaseline(family: Family, lineHeight: number): number {
  // Ascent and descent of Arial, Times New Roman and Courier New.
  const [ascent, descent] = family === "serif" ? [0.891, 0.216] : family === "mono" ? [0.833, 0.3] : [0.905, 0.212];
  return (lineHeight - ascent - descent) / 2 + ascent;
}

/** Windows-1252 beyond Latin-1, which the standard fonts can draw too. */
const WIN_EXTRA = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"].map((c) => c.codePointAt(0)!));

/** True when the standard fonts have this letter (their WinAnsi encoding). */
export function standardHas(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_EXTRA.has(cp);
}

/** The alphabets Noto Sans is brought in for: Latin, Greek and Cyrillic beyond what the standard fonts have, and Vietnamese. */
export function notoHas(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x0100 && cp <= 0x036f) ||
    (cp >= 0x0370 && cp <= 0x03ff) ||
    (cp >= 0x0400 && cp <= 0x052f) ||
    (cp >= 0x1e00 && cp <= 0x1fff) ||
    (cp >= 0x2000 && cp <= 0x206f) ||
    (cp >= 0x20a0 && cp <= 0x20c0) ||
    cp === 0x2116 ||
    cp === 0x2122
  );
}

/** Letters of `text` that no font here can draw (Chinese, Arabic, emoji…), each once. */
export function undrawable(text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) if (!/\s/.test(ch) && !standardHas(ch) && !notoHas(ch)) out.add(ch);
  return [...out];
}

export interface FontGuess {
  /** The font's name for people. */
  name: string;
  /** The run's own font may be used (the save checks it has every letter). */
  own: boolean;
  /** Some letters will come from Noto Sans. */
  noto: boolean;
}

/** What the editor tells people new words will be drawn in, before the file is written. */
export function guessFont(font: RunFont, text: string, bold: boolean, italic: boolean): FontGuess {
  const noto = [...text].some((ch) => !standardHas(ch) && notoHas(ch));
  if (font.program && !font.subset && !font.type3 && bold === font.bold && italic === font.italic) {
    return { name: fontLabel(font.name), own: true, noto: false };
  }
  return { name: fontLabel(standardFont(font.family, bold, italic)), own: false, noto };
}
