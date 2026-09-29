/**
 * Office fonts are rarely installed outside Windows/macOS. Each maps to the
 * font itself first (when the viewer has it), then a metric-compatible free
 * clone where one exists (Carlito for Calibri, Caladea for Cambria, the
 * Liberation family for Arial/Times/Courier), then a close system font.
 */

const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", sans-serif`;
const SERIF = `Georgia, "Times New Roman", "Liberation Serif", serif`;
const MONO = `ui-monospace, Consolas, "Courier New", "Liberation Mono", monospace`;

const STACKS: Record<string, string> = {
  calibri: `Calibri, Carlito, "Segoe UI", Arial, "Liberation Sans", sans-serif`,
  "calibri light": `"Calibri Light", Calibri, Carlito, "Segoe UI Light", "Segoe UI", Arial, sans-serif`,
  cambria: `Cambria, Caladea, Georgia, "Liberation Serif", serif`,
  "cambria math": `"Cambria Math", Cambria, Caladea, Georgia, serif`,
  aptos: `Aptos, ${SANS}`,
  "aptos display": `"Aptos Display", Aptos, ${SANS}`,
  "aptos narrow": `"Aptos Narrow", Aptos, "Arial Narrow", ${SANS}`,
  arial: `Arial, "Liberation Sans", Helvetica, sans-serif`,
  "arial narrow": `"Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif`,
  "arial black": `"Arial Black", Arial, sans-serif`,
  helvetica: `Helvetica, Arial, "Liberation Sans", sans-serif`,
  "helvetica neue": `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif`,
  "segoe ui": `"Segoe UI", ${SANS}`,
  "segoe ui light": `"Segoe UI Light", "Segoe UI", ${SANS}`,
  "segoe ui semibold": `"Segoe UI Semibold", "Segoe UI", ${SANS}`,
  tahoma: `Tahoma, Verdana, "DejaVu Sans", sans-serif`,
  verdana: `Verdana, "DejaVu Sans", sans-serif`,
  "trebuchet ms": `"Trebuchet MS", "Segoe UI", ${SANS}`,
  "century gothic": `"Century Gothic", "URW Gothic", Futura, ${SANS}`,
  "gill sans mt": `"Gill Sans MT", "Gill Sans", ${SANS}`,
  corbel: `Corbel, "Segoe UI", ${SANS}`,
  candara: `Candara, "Segoe UI", ${SANS}`,
  "franklin gothic medium": `"Franklin Gothic Medium", "Arial Narrow", ${SANS}`,
  "times new roman": `"Times New Roman", "Liberation Serif", Times, serif`,
  georgia: `Georgia, "Liberation Serif", serif`,
  garamond: `Garamond, "EB Garamond", Georgia, serif`,
  "book antiqua": `"Book Antiqua", Palatino, "Palatino Linotype", Georgia, serif`,
  "palatino linotype": `"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`,
  constantia: `Constantia, Georgia, serif`,
  "courier new": `"Courier New", "Liberation Mono", Courier, monospace`,
  consolas: `Consolas, ${MONO}`,
  "lucida console": `"Lucida Console", ${MONO}`,
  "comic sans ms": `"Comic Sans MS", "Comic Neue", cursive`,
  impact: `Impact, "Arial Black", sans-serif`,
  "microsoft yahei": `"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif`,
  "ms gothic": `"MS Gothic", "Hiragino Sans", "Noto Sans CJK JP", sans-serif`,
  "yu gothic": `"Yu Gothic", "Hiragino Sans", "Noto Sans CJK JP", sans-serif`,
  "malgun gothic": `"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", sans-serif`,
};

function quote(name: string) {
  return /^[a-zA-Z-]+$/.test(name) ? name : `"${name.replace(/"/g, "")}"`;
}

/** Heuristic for fonts we don't know: serif/mono by name, sans otherwise. */
function genericFor(name: string) {
  const n = name.toLowerCase();
  if (/mono|courier|consol|code/.test(n)) return MONO;
  if (/serif|times|roman|garamond|georgia|bodoni|baskerville|didot|minion|book|antiqua|mincho|song/.test(n) && !/sans/.test(n)) return SERIF;
  return SANS;
}

/** A CSS font-family stack for one Office font name. */
export function fontStack(name: string): string {
  // Font names come from the file: keep only characters real names use, so a
  // crafted name can't close the CSS string or add declarations.
  const clean = name.replace(/[^\p{L}\p{N}\p{M} _.&+-]/gu, "").replace(/\s+/g, " ").trim();
  if (!clean) return SANS;
  const known = STACKS[clean.toLowerCase()];
  if (known) return known;
  return `${quote(clean)}, ${genericFor(clean)}`;
}

/** Maps the first family in a CSS font-family value to a full stack. */
export function mapFontFamily(value: string): string {
  const first = value.split(",")[0]?.trim() ?? "";
  return fontStack(first);
}
