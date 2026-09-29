import { safeCssColor, safeHref, sanitizeStyle } from "../lib/pptx/sanitize.ts";
import { fontStack, mapFontFamily } from "../lib/pptx/fonts.ts";
import { builtInTableLook, tint } from "../lib/pptx/table-style.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

/* ---------------- styles ---------------- */
const typical =
  "color: #C0504D;font-size: 32pt;font-family: Calibri;font-weight: bold;text-decoration: underline;letter-spacing: 1pt;vertical-align: super";
const kept = sanitizeStyle(typical);
check("keeps formatting properties", kept === "color: #C0504D; font-size: 32pt; font-family: Calibri; font-weight: bold; text-decoration: underline; letter-spacing: 1pt; vertical-align: super", kept);
check("keeps paragraph properties",
  sanitizeStyle("text-align: center;margin-top: 0em;margin-left: 27pt;text-indent: -27pt;line-height: 1.08") ===
  "text-align: center; margin-top: 0em; margin-left: 27pt; text-indent: -27pt; line-height: 1.08");

const hostile: [string, string][] = [
  ["url()", "background-color: red; background-image: url(https://evil.test/x.png)"],
  ["url() with spaces/case", "color: red; background: URL ( 'javascript:alert(1)' )"],
  ["expression()", "width: expression(alert(1)); color: blue"],
  ["escapes", "color: \\72 ed; font-family: \\75rl(x)"],
  ["@import", "color: red; @import 'x.css'"],
  ["position/overlay props", "position: fixed; top: 0; left: 0; z-index: 99999; color: red"],
  ["behavior/binding", "behavior: url(x.htc); -moz-binding: url(x.xml#y); color: red"],
  ["var()/attr()", "color: var(--x); content: attr(title)"],
  ["comment smuggling", "color: red/**/; font-size: 12pt"],
  ["image-set()", "background-image: image-set('x.png' 1x)"],
];
for (const [name, css] of hostile) {
  const out = sanitizeStyle(css);
  const bad = /url|expression|\\|@import|position|z-index|behavior|binding|var\(|attr\(|content|image-set|\/\*/i.test(out);
  check(`strips ${name}`, !bad, JSON.stringify(out));
}
{
  const out = sanitizeStyle(`font-family: A"; color: red`);
  check("unbalanced quote drops the declaration", !out.includes('"') && !out.includes("font-family"), JSON.stringify(out));
}
check("gradient text kept", sanitizeStyle("background: linear-gradient(90deg, #f00 0%, #00f 100%); background-clip: text; color: transparent") ===
  "background: linear-gradient(90deg, #f00 0%, #00f 100%); background-clip: text; color: transparent");
check("background-clip other than text dropped", sanitizeStyle("background-clip: border-box") === "");
check("control characters neutralised", !/java\s*script/i.test(sanitizeStyle("color: red; font-family: java\u0000script:x")));
check("mapValue rewrites", sanitizeStyle("font-family: Calibri; color: red", (p, v) => (p === "font-family" ? mapFontFamily(v) : v)).startsWith("font-family: Calibri, Carlito"));
check("mapValue can drop", sanitizeStyle("color: red; font-size: 3pt", (p, v) => (p === "font-size" ? null : v)) === "color: red");
check("huge style is truncated, not choked on", sanitizeStyle("color: red;" + "x".repeat(100000)).length < 5000);

/* ---------------- links ---------------- */
check("http(s)/mailto/# allowed",
  safeHref("https://example.com/a?b=1") === "https://example.com/a?b=1" && safeHref("mailto:a@b.c") === "mailto:a@b.c" && safeHref("#slide=3") === "#slide=3");
for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "ppaction://hlinkshowjump?jump=nextslide"]) {
  check(`rejects ${JSON.stringify(bad)}`, safeHref(bad) === null);
}

/* ---------------- fonts ---------------- */
check("Calibri -> Carlito fallback", fontStack("Calibri").startsWith("Calibri, Carlito"));
check("Cambria -> Caladea/Georgia", fontStack("Cambria").includes("Caladea") && fontStack("Cambria").includes("Georgia"));
check("Aptos -> system sans", fontStack("Aptos").startsWith("Aptos, system-ui"));
check("unknown serif guessed", fontStack("Baskerville Old Face").includes("Georgia"));
check("names with quotes can't break out", !fontStack('Evil"; x').includes('";'));
for (const bad of ["x\n;background-image:url(https://evil.test/a.png);", 'y\\', "z);color:red", "a{}<b>"]) {
  const stack = fontStack(bad);
  check(`font name ${JSON.stringify(bad)} stays one family`, !/[;\\(){}<>\n]/.test(stack), stack);
}

/* ---------------- colours ---------------- */
for (const ok of ["#FFF", "#4F81BD", "#4F81BD80", "red", "rgba(0, 0, 0, 0.5)", "hsl(262 83% 58%)"]) check(`colour ${ok} kept`, safeCssColor(ok) === ok);
for (const bad of ["#000000 0%), url(https://evil.test/x.png), linear-gradient(red", "#000) url(https://evil.test/f.svg#f", "var(--x)", "red;background:url(x)", "", undefined, 42]) {
  check(`colour ${JSON.stringify(bad)} rejected`, safeCssColor(bad) === "transparent");
}

/* ---------------- built-in table style ---------------- */
check("tint", tint("#4F81BD", 0.2) === "#DCE6F2", tint("#4F81BD", 0.2));
const look = builtInTableLook(
  { styleId: "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}", firstRow: true, bandRow: true, lastRow: false, firstCol: false, lastCol: false, bandCol: false },
  ["#4F81BD"], 3, 3
)!;
check("Medium Style 2: header, banded rows",
  look(0, 0).fill === "#4F81BD" && look(0, 0).bold === true && look(1, 0).fill === tint("#4F81BD", 0.4) && look(2, 0).fill === tint("#4F81BD", 0.2));
check("unknown style id -> no look", builtInTableLook({ styleId: "{00000000-0000-0000-0000-000000000000}", firstRow: true, bandRow: true, lastRow: false, firstCol: false, lastCol: false, bandCol: false }, [], 2, 2) === null);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
