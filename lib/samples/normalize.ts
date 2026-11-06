/**
 * Text helpers for matching song titles and artist names in any script.
 * Accents and case never matter (Beyoncé = beyonce), and Japanese, Korean,
 * Chinese or Cyrillic text is kept rather than thrown away.
 */

/**
 * Lower case, accents and other marks removed, "&" read as "and", and only
 * letters, digits and single spaces kept. Apostrophes and dots join what
 * they sit between ("B.I.G." → "big", "Don't" → "dont").
 */
export function norm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/&/g, " and ")
    .replace(/['’‘`´.]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** norm() without spaces: "Run-D.M.C." and "Run DMC" are both "rundmc". */
export function compact(text: string): string {
  return norm(text).replace(/ /g, "");
}

/** compact() with a leading "the" dropped, for artist names ("The Sugarhill Gang"). */
export function artistKey(text: string): string {
  return norm(text).replace(/^the /, "").replace(/ /g, "");
}

/** Pairs of neighbouring characters, counted. Works the same for CJK text. */
function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const chars = Array.from(s);
  for (let i = 0; i < chars.length - 1; i++) {
    const pair = chars[i] + chars[i + 1];
    out.set(pair, (out.get(pair) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity of two strings (0 to 1), after compact(). */
export function dice(a: string, b: string): number {
  const x = compact(a);
  const y = compact(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Array.from(x).length < 2 || Array.from(y).length < 2) return 0;
  const bx = bigrams(x);
  const by = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const n of bx.values()) total += n;
  for (const n of by.values()) total += n;
  for (const [pair, n] of bx) shared += Math.min(n, by.get(pair) ?? 0);
  return (2 * shared) / total;
}

/**
 * Escapes a value for a Lucene query (MusicBrainz search), so a title such
 * as AC/DC's, "Panic! at the Disco" or one with quotes stays one phrase.
 * Control characters are dropped.
 */
export function escapeLucene(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ")
    .trim();
}

/** "KanyeWest" → "Kanye West". Runs of capitals stay together ("LMFAO"). */
export function decamel(text: string): string {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/** Has at least one letter or digit, in any script. */
export function hasWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
