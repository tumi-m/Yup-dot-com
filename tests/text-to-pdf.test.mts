// Text and Markdown to PDF: read back with pdf.js as any reader would.
// Encodings, accents, Greek and Cyrillic in an embedded font, letters the
// font lacks left out and counted (or the file turned away when it has none
// it can draw), wrapping inside the margins, long words broken, new pages as
// they fill, form feeds, page numbers, monospace indents, page sizes; and for
// Markdown: headings, emphasis, links that open (only safe ones), lists,
// tasks, quotes, code, tables, HTML that never renders, images not fetched,
// headings never left alone at a page's foot, cancel.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { Lexer } from "marked";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { textToPdf } = await import("../lib/pdf/text-to-pdf/index.ts");
const { markdownToPdf, decodeEntities, htmlText } = await import("../lib/pdf/text-to-pdf/markdown.ts");
const { decodeText, cleanText, expandTabs, NOT_TEXT } = await import("../lib/pdf/text-to-pdf/read-text.ts");
const { safeLink, MAX_PAGES } = await import("../lib/pdf/text-to-pdf/layout.ts");
const fontsModule = await import("../lib/pdf/text-to-pdf/fonts.ts");
const { textToPdfTool } = await import("../lib/pdf/toolkit.ts");
const { PROCESSORS } = await import("../components/tools/processors.ts");

const fetched: string[] = [];
/** The font files from node_modules, as /vendor serves them in the browser. */
const fonts = async (name: string) => {
  fetched.push(name);
  const pkg = name.startsWith("noto-sans-mono-") ? "noto-sans-mono" : "noto-sans";
  return new Uint8Array(readFileSync(`./node_modules/@fontsource/${pkg}/files/${name}`));
};
const enc = (s: string) => new TextEncoder().encode(s);

interface Item {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  font: string;
}
interface Page {
  width: number;
  height: number;
  items: Item[];
  text: string;
  links: { url?: string; rect: number[] }[];
}

/** Every page's text runs with where they sit, their size and font name. */
async function read(bytes: Uint8Array): Promise<Page[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages: Page[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    await page.getOperatorList();
    const content = await page.getTextContent();
    const items = (content.items as { str: string; transform: number[]; width: number; fontName: string }[])
      .filter((it) => it.str)
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        size: Math.round(it.transform[0] * 100) / 100,
        width: it.width,
        font: (page.commonObjs.has(it.fontName) ? (page.commonObjs.get(it.fontName) as { name: string }).name : it.fontName) ?? "",
      }));
    const [, , width, height] = page.view;
    const links = (await page.getAnnotations()).filter((a) => a.subtype === "Link").map((a) => ({ url: a.url as string | undefined, rect: a.rect as number[] }));
    pages.push({ width, height, items, links, text: items.map((it) => it.str).join("") });
  }
  await doc.destroy();
  return pages;
}
const all = (pages: Page[]) => pages.map((p) => p.text).join("\n");

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------
check("utf-8 with a BOM", decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("café")])) === "café");
check("utf-16 little-endian with a BOM", decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0, 0xe9, 0])) === "Aé");
check("utf-16 big-endian with a BOM", decodeText(new Uint8Array([0xfe, 0xff, 0, 0x41, 0x04, 0x16])) === "AЖ");
check("not utf-8: read as Windows-1252", decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94])) === "café “q”");
check("a binary file is not text", (() => {
  try {
    decodeText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 1, 2]));
    return false;
  } catch (e) {
    return (e as Error).message === NOT_TEXT;
  }
})());
check("CRLF and CR become LF; controls go; form feeds stay", cleanText("a\r\nb\rc\u0007d\fe​") === "a\nb\ncd\fe​");
check("accents typed as marks join their letters", cleanText("café") === "café");
check("tabs go to the next stop", expandTabs("a\tbc\td") === "a   bc  d" && expandTabs("\t\tx", 2) === "    x");

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------
{
  fetched.length = 0;
  const text = "Hello, world.\nCafé crème, naïve, Łódź, Đặng.\nΚαλημέρα κόσμε.\nПривет, мир!\n";
  const out = await textToPdf(enc(text), "notes.txt", { pageNumbers: "true" }, fonts);
  const pages = await read(out.bytes);
  check("txt: one A4 page", pages.length === 1 && Math.round(pages[0].width) === 595 && Math.round(pages[0].height) === 842, pages.map((p) => [p.width, p.height]));
  for (const line of text.trim().split("\n")) check(`txt: reads back exactly: ${line}`, pages[0].text.includes(line), pages[0].text);
  check("txt: nothing left out, no note", out.note === undefined, out.note);
  check("txt: page number at the foot", pages[0].text.includes("Page 1 of 1"));
  check("txt: only the alphabets used were fetched", fetched.every((f) => !/vietnamese|greek-ext|cyrillic-ext/.test(f) || f.includes("vietnamese")) && fetched.some((f) => f.includes("greek")) && !fetched.some((f) => f.includes("mono")), fetched);
  const doc = await PDFDocument.load(out.bytes);
  check("txt: titled after the file", doc.getTitle() === "notes");
  const fontNames = [...new Set(pages[0].items.map((i) => i.font))];
  check("txt: drawn in embedded Noto Sans", fontNames.every((f) => /NotoSans-Regular/.test(f)), fontNames);
  check("txt: text starts at the 1 in margin", Math.min(...pages[0].items.map((i) => i.x)) >= 71.9 && Math.abs(pages[0].items[0].x - 72) < 0.5, pages[0].items[0]);
  check("txt: font size 11 by default", pages[0].items[0].size === 11, pages[0].items[0].size);
}

{
  // Wrapping: a long paragraph stays inside the margins; a long word is broken.
  const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  const longWord = "x".repeat(300);
  const out = await textToPdf(enc(`${words}\n${longWord}\n`), "wrap.txt", { margin: "narrow" }, fonts);
  const pages = await read(out.bytes);
  const right = Math.max(...pages.flatMap((p) => p.items.map((i) => i.x + i.width)));
  check("wrap: nothing runs past the right margin", right <= 595.28 - 36 + 0.5, right);
  const lines = new Set(pages[0].items.map((i) => Math.round(i.y)));
  check("wrap: a long paragraph takes several lines", lines.size > 10, lines.size);
  const found = pages.flatMap((p) => p.items.flatMap((i) => i.str.match(/word\d+/g) ?? []));
  check("wrap: every word is there once, in order", found.join(" ") === words, found.length);
  const xs = pages[0].items.filter((i) => /^x+$/.test(i.str));
  check("wrap: a 300-letter word is broken across lines, all letters kept", xs.length >= 2 && xs.reduce((n, i) => n + i.str.length, 0) === 300, xs.map((i) => i.str.length));
}

{
  // Many pages, numbered; a form feed starts a new page.
  const lines = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}`).join("\n");
  const out = await textToPdf(enc(`${lines}\fAfter the break`), "long.txt", { pageNumbers: "true", fontSize: "11" }, fonts);
  const pages = await read(out.bytes);
  const perPage = Math.floor((841.89 - 144) / (11 * 1.4));
  check("pages: 300 lines fill the pages they need, then the form feed adds one", pages.length === Math.ceil(300 / perPage) + 1, [pages.length, perPage]);
  check("pages: each page is numbered of the total", pages.every((p, i) => p.text.includes(`Page ${i + 1} of ${pages.length}`)));
  check("pages: the text after the form feed starts a page", pages[pages.length - 1].items[0].str === "After the break", pages[pages.length - 1].items[0]);
  check("pages: no line is lost or repeated", (all(pages).match(/Line \d+/g) ?? []).length === 300);
  check("pages: nothing below the bottom margin but the number", pages.every((p) => p.items.filter((i) => !i.str.startsWith("Page ")).every((i) => i.y >= 72 - 3)));
  const bigger = await read((await textToPdf(enc(lines), "long.txt", { fontSize: "14" }, fonts)).bytes);
  const smaller = await read((await textToPdf(enc(lines), "long.txt", { fontSize: "9" }, fonts)).bytes);
  check("size: 14 pt takes more pages than 9 pt", bigger.length > smaller.length && bigger[0].items[0].size === 14 && smaller[0].items[0].size === 9, [bigger.length, smaller.length]);
  const plain = await read((await textToPdf(enc("One line"), "a.txt", { pageNumbers: "" }, fonts)).bytes);
  check("pages: numbers can be left off", !plain[0].text.includes("Page"));
}

{
  // Monospace keeps indents and columns.
  const code = "def f(x):\n    return x * 2\n\tindented by a tab\nname   qty\napple    3";
  const out = await textToPdf(enc(code), "f.py", { font: "mono", pageSize: "letter", margin: "wide" }, fonts);
  const [page] = await read(out.bytes);
  check("mono: Letter page", Math.round(page.width) === 612 && Math.round(page.height) === 792);
  check("mono: Noto Sans Mono", page.items.every((i) => /NotoSansMono/.test(i.font) || i.str.startsWith("Page")), [...new Set(page.items.map((i) => i.font))]);
  const lineStart = (s: string) => page.items.find((i) => i.str.includes(s));
  const em = 0.6 * 11; // Noto Sans Mono: every letter 600 units wide.
  const ret = lineStart("return");
  const left = lineStart("def f")!.x;
  check("mono: wide margin", Math.abs(left - 108) < 0.5, left);
  check("mono: a 4-space indent is kept", !!ret && Math.abs(ret.x + ret.str.indexOf("return") * em - (left + 4 * em)) < 0.5, ret);
  const qty = lineStart("qty")!;
  check("mono: columns line up", Math.abs(qty.x + qty.str.indexOf("qty") * em - (left + 7 * em)) < 0.5, qty);
}

{
  // Letters the font lacks.
  const mixed = await textToPdf(enc("Order 中文 confirmed 😀 ok"), "mixed.txt", {}, fonts);
  check("missing: left out and counted, the rest drawn", mixed.note === "Left out 3 characters the font doesn't have (中 文 😀). It covers Latin, Greek and Cyrillic letters.", mixed.note);
  const [page] = await read(mixed.bytes);
  check("missing: no boxes, the words around them kept", page.text.includes("Order") && page.text.includes("confirmed") && !page.text.includes("中"), page.text);
  const cjk = await settle(textToPdf(enc("这是中文文本。\n第二行。"), "chinese.txt", {}, fonts));
  check("missing: a file with nothing the font has is turned away", /^chinese\.txt: none of this text can be drawn \(for example 这 是 中\)/.test(cjk.error?.message ?? ""), cjk.error?.message);
  const empty = await settle(textToPdf(enc(" \n\n "), "blank.txt", {}, fonts));
  check("empty: says so", empty.error?.message === "blank.txt: this file has no text.", empty.error?.message);
  const binary = await settle(textToPdfTool([new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0, 1])], "report.txt")], {}, {}, false));
  check("binary: a PDF named .txt is turned away", binary.error?.message === `report.txt: ${NOT_TEXT}`, binary.error?.message);
}

{
  // Cancel mid-way, on the progress of a long file.
  const ctl = new AbortController();
  const long = Array.from({ length: 5000 }, (_, i) => `Row ${i}`).join("\n");
  const run = await settle(textToPdf(enc(long), "big.txt", {}, fonts, (fraction) => fraction > 0.1 && ctl.abort(), ctl.signal));
  check("cancel: a long file stops part way with an AbortError", run.error?.name === "AbortError", run.error?.message);
  check("cap: the page limit is stated", MAX_PAGES === 5000);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
check("entities decode", decodeEntities("a &amp; b &lt;c&gt; &#233; &#x3A9; &bogus; &#0;") === "a & b <c> é Ω &bogus; &#0;");
check("html: tags dropped, words kept, scripts gone", htmlText('<div align="center"><img src=x onerror="alert(1)"><b>Hi</b> <script>alert(2)</script>there<br>next<!-- note --></div>') === "Hi there\nnext");
check("links: only web and mail links open", safeLink("https://example.com/a b") === "https://example.com/a%20b" && safeLink("mailto:a@b.co") === "mailto:a@b.co" && !safeLink("javascript:alert(1)") && !safeLink("file:///etc/passwd") && !safeLink("docs/intro.md") && !safeLink("#top"));
check("links: a non-ASCII host becomes punycode", safeLink("https://münchen.de/straße") === "https://xn--mnchen-3ya.de/stra%C3%9Fe", safeLink("https://münchen.de/straße"));

const md = `# Release notes

Intro with **bold**, *italic*, ***both***, ~~gone~~, \`code()\`, [the site](https://example.com/docs?a=1&b=2), [mail](mailto:team@example.com), [a script](javascript:alert(1)) and [a page](other.md). Ελληνικά **έντονα**, *курсив*.

## Lists

- First
- Second, long enough to wrap onto another line under its own text rather than under the bullet at the left
  - Nested
    1. Deep
- [x] Done task
- [ ] Open task

3. Three
4. Four

> Quoted words
> on two lines.

\`\`\`
const a = "<b>&amp;</b>";
\tindented
\`\`\`

| Fruit | Qty | Note |
|:------|----:|:----:|
| Apple | 12 | **fresh** |
| Pear | 7 | ripe |

---

<p onclick="alert(3)">Raw <i>html</i> words</p>

Inline <span style="color:red">span</span> and <script>alert(4)</script> done. Copyright &copy; 2026 &amp; more.

![Sales chart](https://tracker.example/pixel.png)
`;

{
  const out = await markdownToPdf(enc(md), "notes.md", { pageNumbers: "true" }, fonts);
  const pages = await read(out.bytes);
  const page = pages[0];
  const text = all(pages);
  const item = (s: string) => page.items.find((i) => i.str.includes(s));
  check("md: one page", pages.length === 1, pages.length);
  check("md: title from the first heading", (await PDFDocument.load(out.bytes)).getTitle() === "Release notes");
  check("md: h1 larger than h2 larger than body", item("Release notes")!.size === 22 && item("Lists")!.size === 17.6 && item("Intro")!.size === 11, [item("Release notes")?.size, item("Lists")?.size]);
  check("md: headings in bold", /Bold/.test(item("Release notes")!.font) && /Bold/.test(item("Lists")!.font));
  check("md: bold, italic, bold italic", /NotoSans-Bold\b|NotoSans-Bold-/.test(item("bold")!.font) && /Italic/.test(item("italic")!.font) && /BoldItalic/.test(item("both")!.font), [item("bold")?.font, item("italic")?.font, item("both")?.font]);
  check("md: Greek bold and Cyrillic italic", /Bold/.test(item("έντονα")!.font) && /Italic/.test(item("курсив")!.font));
  check("md: inline code in mono", /Mono/.test(item("code()")!.font));
  const urls = page.links.map((l) => l.url);
  check("md: web and mail links open", urls.includes("https://example.com/docs?a=1&b=2") && urls.includes("mailto:team@example.com"), urls);
  check("md: script and relative links don't", page.links.length === 2 && text.includes("a script") && text.includes("a page"), urls);
  const site = item("the site")!;
  const box = page.links.find((l) => l.url?.startsWith("https://example.com"))!.rect;
  check("md: the link's clickable box covers its words", box[0] <= site.x + 0.5 && box[2] >= site.x + site.width - 0.5 && box[1] < site.y && box[3] > site.y, [box, site.x, site.y]);
  check("md: list markers", text.includes("•") && text.includes("–") && text.includes("1.") && text.includes("3.") && text.includes("4."));
  check("md: wrapped list text sits under its own text, not the bullet", (() => {
    const second = page.items.filter((i) => i.str.includes("Second") || i.str.includes("under the bullet"));
    return second.length === 2 && Math.abs(second[0].x - second[1].x) < 0.5 && second[0].x > 72 + 10;
  })(), page.items.filter((i) => i.str.includes("Second") || i.str.includes("under the bullet")).map((i) => i.x));
  check("md: nested items further in", item("Nested")!.x > item("First")!.x && item("Deep")!.x > item("Nested")!.x);
  check("md: tasks show their boxes", text.includes("[x] Done task") && text.includes("[ ] Open task"), text.match(/\[.\] \w+ task/g));
  check("md: quotes indented", item("Quoted words")!.x > 72 + 10 && text.includes("Quoted words on two lines."));
  const indented = item("indented")!;
  const codeLeft = item("const a")!.x;
  check("md: code kept as written, in mono, its tab four letters in", text.includes('const a = "<b>&amp;</b>";') && /Mono/.test(item("const a")!.font) && Math.abs(indented.x + indented.str.indexOf("indented") * 0.6 * indented.size - (codeLeft + 4 * 0.6 * indented.size)) < 0.5, [indented, codeLeft]);
  const fruit = item("Fruit")!;
  const apple = item("Apple")!;
  const qty12 = page.items.find((i) => i.str === "12")!;
  const qtyHead = item("Qty")!;
  check("md: table header bold, cells in rows", /Bold/.test(fruit.font) && Math.abs(fruit.x - apple.x) < 0.5 && apple.y < fruit.y && /Bold/.test(item("fresh")!.font));
  check("md: right-aligned column lines up on the right", Math.abs(qty12.x + qty12.width - (qtyHead.x + qtyHead.width)) < 0.6, [qty12.x + qty12.width, qtyHead.x + qtyHead.width]);
  check("md: HTML never renders: tags gone, words kept", text.includes("Raw html words") && text.includes("Inline span and") && !text.includes("<p") && !text.includes("alert") && !text.includes("<span"), text.slice(text.indexOf("Raw") - 5, text.indexOf("Raw") + 60));
  check("md: entities decoded", text.includes("Copyright © 2026 & more."));
  check("md: images not fetched, described", text.includes("[Image: Sales chart]") && !text.includes("tracker.example"));
  check("md: page number", text.includes("Page 1 of 1"));
}

{
  // A long document: headings never sit alone at the foot of a page.
  const sections = Array.from({ length: 40 }, (_, i) => `## Section ${i + 1}\n\n${"Some words to fill the page. ".repeat(12 + (i % 5) * 7)}`).join("\n\n");
  const out = await markdownToPdf(enc(sections), "long.md", {}, fonts);
  const pages = await read(out.bytes);
  check("md long: several pages", pages.length > 3, pages.length);
  const orphans = pages.filter((p, i) => {
    if (i === pages.length - 1) return false;
    const body = p.items.filter((it) => !it.str.startsWith("Page "));
    const last = body[body.length - 1];
    return last && last.size > 11;
  });
  check("md long: no page ends with a heading", orphans.length === 0, orphans.map((p) => p.items[p.items.length - 1]?.str));
  check("md long: every section is there", (all(pages).match(/Section \d+/g) ?? []).length === 40);

  // A code block longer than a page carries on, shaded, on the next.
  const longCode = "```\n" + Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join("\n") + "\n```";
  const code = await read((await markdownToPdf(enc(longCode), "code.md", {}, fonts)).bytes);
  check("md code: a long block runs onto the next page, every line kept", code.length === 2 && (all(code).match(/line \d+/g) ?? []).length === 90, code.length);

  // A table with many rows repeats its header on the next page.
  const rows = Array.from({ length: 80 }, (_, i) => `| Item ${i + 1} | ${i} |`).join("\n");
  const table = await read((await markdownToPdf(enc(`| Name | Value |\n|---|---|\n${rows}`), "t.md", {}, fonts)).bytes);
  check("md table: rows run onto a second page with the header again", table.length >= 2 && table.every((p) => p.items[0]?.str === "Name"), table.map((p) => p.items[0]?.str));
  check("md table: every row once", (all(table).match(/Item \d+/g) ?? []).length === 80);

  // A table too wide for the page: columns narrowed, words wrapped, nothing past the margin.
  const wide = `| ${Array.from({ length: 8 }, (_, i) => `Column ${i}`).join(" | ")} |\n|${"---|".repeat(8)}\n| ${Array.from({ length: 8 }, () => "several words in each cell").join(" | ")} |`;
  const w = await read((await markdownToPdf(enc(wide), "wide.md", {}, fonts)).bytes);
  const right = Math.max(...w[0].items.map((i) => i.x + i.width));
  check("md table: a wide table stays inside the margins", right <= 595.28 - 72 + 0.5, right);

  // Monospace body text for Markdown, headings still in Sans.
  const mono = await read((await markdownToPdf(enc("# Head\n\nBody text"), "m.md", { font: "mono" }, fonts)).bytes);
  check("md mono: body in mono, heading in Sans Bold", /Mono/.test(mono[0].items.find((i) => i.str === "Body text")!.font) && /NotoSans-Bold/.test(mono[0].items.find((i) => i.str === "Head")!.font));

  const nothing = await settle(markdownToPdf(enc("<!-- only a comment -->\n\n[ref]: https://example.com"), "empty.md", {}, fonts));
  check("md: a file with nothing to show says so", nothing.error?.message === "empty.md: this file has no text.", nothing.error?.message);
  const cjk = await settle(markdownToPdf(enc("# 标题\n\n内容"), "zh.md", {}, fonts));
  check("md: all-Chinese Markdown is turned away with the reason", /^zh\.md: none of this text can be drawn/.test(cjk.error?.message ?? ""), cjk.error?.message);
}

// ---------------------------------------------------------------------------
// Fonts and the tool
// ---------------------------------------------------------------------------
{
  // The alphabets each file covers match @fontsource's own CSS.
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const ours = new Map(fontsModule.SUBSET_RANGES.map(([subset, list]) => [subset, list.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(",")]));
  for (const pkg of ["noto-sans", "noto-sans-mono"]) {
    const css = readFileSync(`./node_modules/@fontsource/${pkg}/400.css`, "utf8");
    const theirs = new Map([...css.matchAll(/\/\* (?:noto-sans-mono|noto-sans)-([a-z-]+)-400-normal \*\/[^}]*?unicode-range: ([^;]+);/g)].map(([, subset, r]) => [subset, r.trim()]));
    const differ = [...ours].filter(([subset, list]) => theirs.get(subset) !== list).map(([subset]) => subset);
    check(`fonts: ${pkg} alphabets match its CSS`, differ.length === 0 && theirs.size >= ours.size, differ);
  }
  const version = (pkg: string) => JSON.parse(readFileSync(`./node_modules/@fontsource/${pkg}/package.json`, "utf8")).version;
  check("fonts: version stamps match the installed fonts", fontsModule.NOTO_SANS_VERSION === version("noto-sans") && fontsModule.NOTO_SANS_MONO_VERSION === version("noto-sans-mono"));

  // Subsetting: a one-line file is small, the fonts inside it hold only its letters.
  const small = await textToPdf(enc("Short note."), "s.txt", { pageNumbers: "" }, fonts);
  check("fonts: subset, so a one-line PDF stays small", small.bytes.length < 12_000, small.bytes.length);
  check("fonts: marked lexer gives tokens (dependency in place)", new Lexer().lex("# x")[0].type === "heading");

  // Through the tool, as the page calls it (on this thread here, a worker in the browser).
  const p = PROCESSORS["markdown-to-pdf"];
  const txt = PROCESSORS["txt-to-pdf"];
  check("tool: options as the page sends them", ["pageSize", "margin", "fontSize", "font", "pageNumbers"].every((k) => p.fields.some((f) => f.key === k)) && txt.cancellable && p.cancellable);
  check("tool: Markdown page takes .md, also .txt", p.accept.includes(".md") && !!p.alsoAccepts?.includes(".txt"));
  const result = await textToPdfTool([new File([enc("Name\tQty\nWidget\t3")], "stock.txt", { type: "text/plain" })], { font: "mono" }, {}, false).catch((e) => e as Error);
  // /vendor isn't served in Node, so the font can't load: said plainly, not as a broken file.
  check("tool: a font that can't load says so", result instanceof Error && result.message === fontsModule.FONT_FAILED, result instanceof Error ? result.message : result.filename);
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
