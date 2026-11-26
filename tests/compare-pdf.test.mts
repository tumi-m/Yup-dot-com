// Compare PDFs: the words two files are compared by (ligatures, odd spaces,
// words broken over a line end), the word diff over the whole document
// (changes, moves to another page, pages added or taken out in the middle,
// files of very different lengths, many pages), and the files it writes,
// opened again with pdf.js as an independent reader: the report's text, and
// the marked copies' highlights, strike-outs and notes landing on the words
// they mark, on turned pages, sideways text, mixed and offset page sizes.
// Also forms, comments kept, owner-password, locked and broken files,
// pages without text compared by how they look, and Cancel.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { PDFDocument, PDFString, StandardFonts, degrees, rgb, type PDFFont } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { loadForRender } = await import("../lib/pdf/render.ts");
const { compareDocuments } = await import("../lib/pdf/compare/run.ts");
const { compareWords, withPictures } = await import("../lib/pdf/compare/index.ts");
const { diffWords } = await import("../lib/pdf/compare/diff.ts");
const { normalise, readWords, joinWords, wordCount } = await import("../lib/pdf/compare/words.ts");
const { pairPages } = await import("../lib/pdf/compare/pages.ts");
const { pixelDiff, differencePicture } = await import("../lib/pdf/compare/pixels.ts");
const { marksFor } = await import("../lib/pdf/compare/marks.ts");
const { reportMarkdown, escapeMarkdown, summaryLine } = await import("../lib/pdf/compare/report.ts");
const view = await import("../lib/pdf/compare/view.ts");
const { friendlyPdfError } = await import("../lib/pdf/errors.ts");
const { isAbort } = await import("../lib/abort.ts");
const { LIMITS } = await import("../lib/limits.ts");
const { TOOLS, getTool, relatedTools } = await import("../lib/tools.tsx");
const { filterTools } = await import("../components/tool-filter.ts");
const { panelSpec } = await import("../components/tools/panel-spec.tsx");
const sitemap = (await import("../app/sitemap.ts")).default;

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

// pdf.js prints a line for every glyph it has no font for; the checks are what matter here.
const warn = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
  warn(...args);
};

// Pages are drawn to compare how they look: node-canvas stands in for the browser's.
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }),
  };
} catch {
  canvasMod = null;
}
const canvas = canvasMod ? () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }) as unknown as HTMLCanvasElement : undefined;
const fonts = async (name: string) =>
  new Uint8Array(readFileSync(`./node_modules/@fontsource/${name.startsWith("noto-sans-mono-") ? "noto-sans-mono" : "noto-sans"}/files/${name}`));

// --- Files to compare ----------------------------------------------------------

/** A piece of text on a page: drawn on its own, so pdf.js reads it as its own item. */
interface Piece {
  text: string;
  x: number;
  y: number;
  size?: number;
  /** Degrees, counter-clockwise, as pdf-lib draws. */
  rotate?: number;
}
interface PageSpec {
  size?: [number, number];
  rotate?: number;
  mediaBox?: [number, number, number, number];
  lines?: string[];
  pieces?: Piece[];
  box?: { x: number; y: number; w: number; h: number; color?: [number, number, number] };
}

async function make(pages: PageSpec[], extra?: (doc: PDFDocument, font: PDFFont) => Promise<void> | void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of pages) {
    const page = doc.addPage(spec.size ?? [595, 842]);
    if (spec.mediaBox) page.setMediaBox(...spec.mediaBox);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    const top = (spec.mediaBox ? spec.mediaBox[1] + spec.mediaBox[3] : page.getHeight()) - 60;
    const left = (spec.mediaBox?.[0] ?? 0) + 60;
    (spec.lines ?? []).forEach((line, i) => page.drawText(line, { x: left, y: top - i * 18, size: 12, font }));
    for (const p of spec.pieces ?? []) page.drawText(p.text, { x: p.x, y: p.y, size: p.size ?? 12, font, rotate: degrees(p.rotate ?? 0) });
    if (spec.box) {
      const [r, g, b] = spec.box.color ?? [0.2, 0.2, 0.2];
      page.drawRectangle({ x: spec.box.x, y: spec.box.y, width: spec.box.w, height: spec.box.h, color: rgb(r, g, b) });
    }
  }
  await extra?.(doc, font);
  return doc.save();
}

/** A sentence of `n` words, numbered so each is its own. */
const sentence = (seed: number, n = 9) => Array.from({ length: n }, (_, i) => `w${seed}x${i}`).join(" ") + ".";

async function compare(a: Uint8Array, b: Uint8Array, opts: Parameters<typeof compareDocuments>[2] = {}) {
  const la = await loadForRender(a);
  const lb = await loadForRender(b);
  try {
    return await compareDocuments(
      { file: new Blob([a as Uint8Array<ArrayBuffer>]), name: "original.pdf", loaded: la },
      { file: new Blob([b as Uint8Array<ArrayBuffer>]), name: "changed.pdf", loaded: lb },
      { canvas, fonts, date: "18 November 2026", ...opts }
    );
  } finally {
    la.destroy();
    lb.destroy();
  }
}

const describe = (r: Awaited<ReturnType<typeof compare>>) => r.result.changes.map((c) => `${c.kind}:${c.oldText}>${c.newText}@${c.oldPage ?? "-"}/${c.newPage ?? "-"}`);

// --- Reading the files back with pdf.js -----------------------------------------

type Rect = { x0: number; y0: number; x1: number; y1: number };
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const bounds = (pts: number[][]): Rect => ({
  x0: Math.min(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])),
  x1: Math.max(...pts.map((p) => p[0])),
  y1: Math.max(...pts.map((p) => p[1])),
});

interface ReadBack {
  pages: { width: number; height: number; text: string; items: { str: string; box: Rect }[]; annots: { subtype: string; contents: string; box: Rect; fieldName?: string }[] }[];
}

/** Every page's text items and annotations, in displayed points from the top left. */
async function readBack(bytes: Uint8Array): Promise<ReadBack> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const pages: ReadBack["pages"] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = (content.items as { str: string; transform: number[]; width: number }[])
      .filter((i) => i.str?.trim())
      .map((i) => {
        const [a, b, c, d, e, f] = i.transform;
        const n2 = Math.hypot(a, b) || 1;
        const along = [(a / n2) * i.width, (b / n2) * i.width];
        const up = [c * 0.7, d * 0.7];
        const pts = [
          [e, f],
          [e + along[0], f + along[1]],
          [e + up[0], f + up[1]],
          [e + along[0] + up[0], f + along[1] + up[1]],
        ].map(([x, y]) => vp.convertToViewportPoint(x, y));
        return { str: i.str, box: bounds(pts) };
      });
    const annots = ((await page.getAnnotations()) as { subtype: string; rect: number[]; contentsObj?: { str: string }; fieldName?: string }[]).map((a) => {
      const [x0, y0, x1, y1] = vp.convertToViewportRectangle(a.rect);
      return { subtype: a.subtype, contents: a.contentsObj?.str ?? "", box: { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }, fieldName: a.fieldName };
    });
    pages.push({ width: vp.width, height: vp.height, text: items.map((i) => i.str).join(" "), items, annots });
    page.cleanup();
  }
  await doc.destroy();
  return { pages };
}

/** The annotation of `subtype` on `page` covers the item `str` (most of it, and not much more). */
function marks(back: ReadBack, page: number, subtype: string, str: string): { ok: boolean; why: unknown } {
  const p = back.pages[page];
  const item = p?.items.find((i) => i.str === str);
  if (!item) return { ok: false, why: `no item "${str}" on page ${page + 1}` };
  const annot = p.annots.filter((a) => a.subtype === subtype).find((a) => area(meet(a.box, item.box)) > 0);
  if (!annot) return { ok: false, why: { item: item.box, annots: p.annots } };
  const covered = area(meet(annot.box, item.box)) / area(item.box);
  const extra = area(annot.box) / area(item.box);
  return { ok: covered > 0.6 && extra < 3, why: { covered, extra, item: item.box, annot: annot.box } };
}

// --- The words compared ------------------------------------------------------------
{
  check("normalise: ligatures, odd spaces and hyphens evened out", normalise("ﬁne ﬂow  eﬀort‑based") === "fine flow effort-based", normalise("ﬁne ﬂow  eﬀort‑based"));
  check("normalise: zero-width joiners vanish", normalise("co​op﻿") === "coop");

  // Hand-made pages, as the parser gives them: a line is spans with their places.
  const span = (text: string, x: number, y: number, width: number) => ({ text, x, y, width, height: 12, fontSize: 12, fontName: "Helvetica", bold: false });
  const line = (spans: ReturnType<typeof span>[]) => ({ text: spans.map((s) => s.text).join(" "), x: spans[0].x, right: 0, y: spans[0].y, fontSize: 12, bold: false, rtl: false, spans });
  const pageOf = (lines: ReturnType<typeof line>[]) => ({ lines, chars: 200, width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] });

  const broken = readWords([pageOf([line([span("A second line of infor-", 60, 700, 140)]), line([span("mation here.", 60, 682, 70)])])]);
  const whole = readWords([pageOf([line([span("A second line of information", 60, 700, 160)]), line([span("here.", 60, 682, 30)])])]);
  check("a word broken over a line end is one word", broken.words.some((w) => w.text === "information" && w.boxes.length === 2), broken.words.map((w) => w.text));
  check("…with a box on each line", broken.words.find((w) => w.text === "information")?.boxes.map((b) => Math.round(b.y)).join() === "90,108", broken.words.find((w) => w.text === "information")?.boxes);
  check("…and matches the same word unbroken", compareWords(broken, whole).changes.length === 0, compareWords(broken, whole).changes);
  const real = readWords([pageOf([line([span("a well-", 60, 700, 40)]), line([span("Known name", 60, 682, 60)])])]);
  check("a hyphen before a capital is kept", joinWords(real.words) === "a well - Known name" || real.words.map((w) => w.text).join("|") === "a|well|-|Known|name", real.words.map((w) => w.text));
  const lig = readWords([pageOf([line([span("The ﬁnal oﬃce ﬁgures", 60, 700, 120)])])]);
  const plain = readWords([pageOf([line([span("The final office figures", 60, 700, 130)])])]);
  check("ligatures match their letters", compareWords(lig, plain).changes.length === 0, compareWords(lig, plain).changes);
  const spaced = readWords([pageOf([line([span("one   two three", 60, 700, 120)])])]);
  check("runs of spaces are one", spaced.words.map((w) => w.text).join("|") === "one|two|three");
  const quoted = readWords([pageOf([line([span("sixty days' notice (in writing), please.", 60, 700, 200)])])]);
  check("words are listed as printed", joinWords(quoted.words) === "sixty days' notice (in writing), please.", joinWords(quoted.words));
  check("signs don't count as words", wordCount("New page, in the middle.") === 5 && wordCount("— , .") === 0);
  check("words in reading order carry their page", readWords([pageOf([line([span("a b", 60, 700, 20)])]), pageOf([line([span("c", 60, 700, 10)])])]).words.map((w) => w.page).join() === "0,0,1");
}

// --- The word diff ------------------------------------------------------------------
{
  const a = await make([{ lines: ["The quick brown fox jumps over the lazy dog.", "Second line stays."] }]);
  const b = await make([{ lines: ["The slow brown fox jumps over the lazy cat today.", "Second line stays."] }]);
  const r = await compare(a, b);
  check("changed words are found, with their pages", describe(r).join("; ") === "changed:quick>slow@0/0; changed:dog>cat today@0/0", describe(r));
  check("summary counts words, not signs", r.result.summary.wordsAdded >= 2 && r.result.summary.wordsRemoved === 2, r.result.summary);

  // Taken out and put in.
  const c = await make([{ lines: ["Alpha beta gamma delta.", "Epsilon zeta eta theta."] }]);
  const d = await make([{ lines: ["Alpha gamma delta.", "Epsilon zeta eta theta iota kappa."] }]);
  const r2 = await compare(c, d);
  check("removed and added", describe(r2).includes("removed:beta>@0/0") && describe(r2).some((x) => x.startsWith("added:>iota kappa")), describe(r2));

  // Identical files.
  const same = await compare(c, await make([{ lines: ["Alpha beta gamma delta.", "Epsilon zeta eta theta."] }]));
  check("identical files: no differences", view.identical(same.result) && same.result.changes.length === 0);
  check("…and no marked copies to download", same.exports.markedA === null && same.exports.markedB === null);
  const sameReport = await readBack(same.exports.report);
  check("…the report says so", /No differences found/.test(sameReport.pages[0].text), sameReport.pages[0].text);

  // Text that wraps differently is the same text.
  const wrapA = await make([{ lines: ["The supplier shall deliver the goods within thirty days of the", "order date, and the buyer shall pay each invoice within four-", "teen days."] }]);
  const wrapB = await make([{ lines: ["The supplier shall deliver the goods within", "thirty days of the order date, and the buyer shall pay", "each invoice within fourteen days."] }]);
  const wrap = await compare(wrapA, wrapB);
  check("rewrapped text and a hyphenated word match", wrap.result.changes.length === 0, describe(wrap));
}

// --- Moves, pages added and taken out, very different lengths -------------------------
{
  const p1 = [sentence(1), sentence(2), sentence(3)];
  const p2 = [sentence(4), sentence(5), "This paragraph will move to the last page of the file."];
  const p3 = [sentence(6), sentence(7)];
  const a = await make([{ lines: p1 }, { lines: p2 }, { lines: p3 }]);
  const b = await make([{ lines: p1 }, { lines: ["A new page in the middle, with words of its own."] }, { lines: p2.slice(0, 2) }, { lines: [...p3, "This paragraph will move to the last page of the file."] }]);
  const r = await compare(a, b);
  const kinds = r.result.changes.map((c) => c.kind);
  check("a page added in the middle is one addition", r.result.changes.filter((c) => c.kind === "added").length === 1 && r.result.changes.find((c) => c.kind === "added")?.newPage === 1, describe(r));
  const moved = r.result.changes.find((c) => c.kind === "moved");
  check("text moved to another page is one move, from page 2 to page 4", !!moved && moved.oldPage === 1 && moved.newPage === 3 && /move to the last page/.test(moved.oldText), describe(r));
  check("nothing else changed", kinds.length === 2, kinds);
  check("pages paired around the new one", JSON.stringify(r.result.pairs) === JSON.stringify([{ a: 0, b: 0 }, { a: null, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }]), r.result.pairs);
  check("summary: one page added", r.result.summary.pagesAdded.join() === "1" && r.result.summary.pagesRemoved.length === 0, r.result.summary);

  // A page taken out of the middle.
  const c = await make([{ lines: [sentence(10)] }, { lines: [sentence(11)] }, { lines: [sentence(12)] }, { lines: [sentence(13)] }]);
  const d = await make([{ lines: [sentence(10)] }, { lines: [sentence(11)] }, { lines: [sentence(13)] }]);
  const r2 = await compare(c, d);
  check("a page taken out of the middle", JSON.stringify(r2.result.pairs) === JSON.stringify([{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: 2, b: null }, { a: 3, b: 2 }]) && r2.result.summary.pagesRemoved.join() === "2", r2.result.pairs);
  check("…its words removed, on page 3 of the original", r2.result.changes.length === 1 && r2.result.changes[0].kind === "removed" && r2.result.changes[0].oldPage === 2, describe(r2));

  // One page against thirty.
  const short = await make([{ lines: [sentence(1), sentence(2)] }]);
  const long = await make(Array.from({ length: 30 }, (_, i) => ({ lines: i === 0 ? [sentence(1), sentence(2)] : [sentence(100 + i)] })));
  const r3 = await compare(short, long);
  check("one page against thirty: 29 pages added, page 1 the same", r3.result.summary.pagesAdded.length === 29 && r3.result.pairs[0].a === 0 && r3.result.pairs[0].b === 0, r3.result.summary);
  const r4 = await compare(long, short);
  check("…and the other way round, 29 taken out", r4.result.summary.pagesRemoved.length === 29 && r4.result.changes.every((c) => c.kind === "removed"), r4.result.summary);
  check("…with one change that lists them all", r4.result.changes.length === 1 && wordCount(r4.result.changes[0].oldText) === 29 * 9, r4.result.changes.length);

  // Pages paired by shared words: unit level.
  const shared = new Map([["0:0", 50], ["1:2", 40], ["2:3", 40]]);
  check("pairing: unmatched pages between matched ones are paired in turn", JSON.stringify(pairPages(shared, 3, 4)) === JSON.stringify([{ a: 0, b: 0 }, { a: null, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }]));
  check("pairing: two files with nothing in common side by side", JSON.stringify(pairPages(new Map(), 2, 3)) === JSON.stringify([{ a: 0, b: 0 }, { a: 1, b: 1 }, { a: null, b: 2 }]));
}

// --- Long, very different files: the diff gives up and lines up lines first ------------
{
  const words = (seed: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ text: `t${(i * seed) % 997}`, key: `t${(i * seed) % 997}`, page: Math.floor(i / 300), line: Math.floor(i / 10), boxes: [] }));
  const a = words(7, 30000);
  const b = words(13, 30000);
  const started = Date.now();
  const d = diffWords(a, b, { timeout: 50 });
  const took = Date.now() - started;
  const removed = d.changes.reduce((n, c) => n + (c.kind === "moved" ? 0 : c.a.end - c.a.start), 0);
  const kept = [...d.shared.values()].reduce((n, v) => n + v, 0);
  check("a slow diff falls back to lines first, and says so", d.coarse, took);
  check("…every word of the original is kept or taken out once", removed + kept + d.changes.filter((c) => c.kind === "moved").reduce((n, c) => n + c.a.end - c.a.start, 0) === a.length, { removed, kept });
  check("…in good time", took < 15000, took);
}

// --- Many pages -----------------------------------------------------------------------
{
  const pages = (changed: boolean) => Array.from({ length: 300 }, (_, i) => ({ lines: [`Page ${i + 1}.`, sentence(i), changed && i === 249 ? "The goods are services now." : "The goods are goods now."] }));
  const a = await make(pages(false));
  const b = await make(pages(true));
  const steps: number[] = [];
  const started = Date.now();
  const r = await compare(a, b, { progress: (f) => steps.push(f) });
  const took = Date.now() - started;
  check("300 pages: the one change is found on page 250", describe(r).join() === "changed:goods>services@249/249", describe(r));
  check("…progress only goes forward, to the end", steps.length > 300 && steps.every((f, i) => i === 0 || f >= steps[i - 1] - 1e-9) && steps[steps.length - 1] > 0.95, steps.slice(-3));
  check("…in good time", took < 30000, took);
}

// --- The marked copies, on all kinds of pages -------------------------------------------
{
  const a = await make([
    { pieces: [{ text: "The parties are", x: 60, y: 760 }, { text: "Acme", x: 150, y: 760 }, { text: "and Borealis.", x: 190, y: 760 }] },
    // A landscape page stored portrait and turned, its text drawn so it reads upright.
    { size: [612, 792], rotate: 90, pieces: [{ text: "Turned page text", x: 100, y: 100, rotate: 90 }, { text: "monthly", x: 100, y: 220, rotate: 90 }] },
    // Text sideways on the page as shown.
    { size: [612, 792], rotate: 90, pieces: [{ text: "Sideways words", x: 60, y: 700 }, { text: "blue", x: 200, y: 700 }] },
    // A page whose MediaBox doesn't start at 0,0, a different size.
    { size: [612, 792], mediaBox: [40, 50, 500, 600], pieces: [{ text: "Offset page", x: 100, y: 500 }, { text: "first", x: 200, y: 500 }] },
  ]);
  const b = await make([
    { pieces: [{ text: "The parties are", x: 60, y: 760 }, { text: "Zenith", x: 150, y: 760 }, { text: "and Borealis.", x: 200, y: 760 }] },
    { size: [612, 792], rotate: 90, pieces: [{ text: "Turned page text", x: 100, y: 100, rotate: 90 }, { text: "weekly", x: 100, y: 220, rotate: 90 }] },
    { size: [612, 792], rotate: 90, pieces: [{ text: "Sideways words", x: 60, y: 700 }, { text: "green", x: 200, y: 700 }] },
    { size: [420, 595], mediaBox: [40, 50, 300, 400], pieces: [{ text: "Offset page", x: 100, y: 300 }, { text: "second", x: 200, y: 300 }] },
  ]);
  const r = await compare(a, b);
  check("four changes, one a page", describe(r).join("; ") === "changed:Acme>Zenith@0/0; changed:monthly>weekly@1/1; changed:blue>green@2/2; changed:first>second@3/3", describe(r));
  const backA = await readBack(r.exports.markedA!);
  const backB = await readBack(r.exports.markedB!);
  for (const [page, oldWord, newWord, what] of [
    [0, "Acme", "Zenith", "a plain page"],
    [1, "monthly", "weekly", "a turned page"],
    [2, "blue", "green", "sideways text"],
    [3, "first", "second", "an offset page of another size"],
  ] as const) {
    const struck = marks(backA, page, "StrikeOut", oldWord);
    const lit = marks(backB, page, "Highlight", newWord);
    check(`marks land on the words: ${what}, struck through in the original`, struck.ok, struck.why);
    check(`…and highlighted in the changed version`, lit.ok, lit.why);
  }
  const note = backB.pages[0].annots.find((x) => x.subtype === "Highlight");
  check("each mark says what changed", note?.contents === "Changed from “Acme” (page 1)", note?.contents);
  check("the pages themselves are left as they were", backA.pages.map((p) => p.text).join("|") === (await readBack(a)).pages.map((p) => p.text).join("|"));
  check("page sizes kept", JSON.stringify(backB.pages.map((p) => [Math.round(p.width), Math.round(p.height)])) === JSON.stringify([[595, 842], [792, 612], [792, 612], [300, 400]]), backB.pages.map((p) => [p.width, p.height]));
  // Words only in one file: a note where they would go in the other.
  const c = await make([{ lines: ["Keep these words.", "Gone soon."] }]);
  const d = await make([{ lines: ["Keep these words."] }]);
  const r2 = await compare(c, d);
  const notes = (await readBack(r2.exports.markedB!)).pages[0].annots;
  check("removed words: a note in the changed version where they were", notes.length === 1 && notes[0].subtype === "Text" && /Removed from here \(page 1\): “Gone soon\.”/.test(notes[0].contents), notes);
}

// --- The report ---------------------------------------------------------------------------
{
  const a = await make([{ lines: ["Price: 100 euros, payable monthly."] }, { lines: ["Second page."] }]);
  const b = await make([{ lines: ["Price: 120 euros, payable weekly."] }, { lines: ["Second page."] }, { lines: ["Appendix A: delivery terms."] }]);
  const r = await compare(a, b);
  const back = await readBack(r.exports.report);
  const text = back.pages.map((p) => p.text).join(" ").replace(/\s+/g, " ");
  // Escaped signs are runs of their own, which the reader here puts spaces between.
  const squashed = text.replace(/\s+/g, "");
  check("the report names both files and the date", squashed.includes("Comparisonoforiginal.pdfandchanged.pdf") && squashed.includes("18November2026"), text.slice(0, 200));
  check("…sums it up", squashed.includes(summaryLine(r.result).replace(/\s+/g, "")) && squashed.includes("Page3ofthechangedversionisnew"), text);
  check("…and a page with a few words isn't called a scan", !/No text on/.test(text) && r.result.scanned.a.length === 0, r.result.scanned);
  check("…lists each change with its words", /100/.test(text) && /120/.test(text) && /monthly/.test(text) && /weekly/.test(text) && /Appendix A/.test(text), text);
  check("…on A4 pages, numbered", Math.round(back.pages[0].width) === 595 && /1 \/ 1|Page 1|^1$|\b1\b/.test(back.pages[back.pages.length - 1].text), back.pages.map((p) => p.text.slice(-20)));
  check("names are escaped in the report", escapeMarkdown("a*b|c_[d].pdf") === "a\\*b\\|c\\_\\[d\\]\\.pdf");
  const md = reportMarkdown(r.result, { a: "x.pdf", b: "y.pdf", pagesA: 2, pagesB: 3 }, "today");
  check("the report's table has a row per change", md.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length === r.result.changes.length, md);
}

// --- Forms and comments ------------------------------------------------------------------
{
  const form = async (name: string) =>
    make([{ lines: ["Application form"] }], async (doc) => {
      const page = doc.getPage(0);
      const field = doc.getForm().createTextField("applicant");
      field.setText(name);
      field.addToPage(page, { x: 60, y: 700, width: 200, height: 20 });
      // A reviewer's note already on the page.
      const note = doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [400, 700, 420, 720], Contents: PDFString.of("Check the spelling") });
      page.node.addAnnot(doc.context.register(note));
    });
  const a = await form("Alice Smith");
  const b = await form("Alice Smyth");
  const r = await compare(a, b);
  check("form values are compared", describe(r).join() === "changed:Smith>Smyth@0/0", describe(r));
  const back = await readBack(r.exports.markedB!);
  check("the marked copy keeps the field and the note already there", back.pages[0].annots.some((x) => x.subtype === "Widget" && x.fieldName === "applicant") && back.pages[0].annots.some((x) => x.subtype === "Text" && /spelling/.test(x.contents)), back.pages[0].annots.map((x) => x.subtype));
  const filled = await PDFDocument.load(r.exports.markedB!);
  check("…with its value", filled.getForm().getTextField("applicant").getText() === "Alice Smyth");
}

// --- Locked, owner-password and broken files ------------------------------------------------
{
  const a = await make([{ lines: ["Confidential terms, version one."] }]);
  const b = await make([{ lines: ["Confidential terms, version two."] }]);
  const owner = await SecurePDFDocument.load(b);
  owner.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false, modifying: false } });
  const restricted = await owner.save();
  const r = await compare(a, restricted);
  check("owner-password file: compared", describe(r).join() === "changed:one>two@0/0", describe(r));
  const back = await readBack(r.exports.markedB!);
  check("…and its marked copy opens without a password", back.pages[0].annots.some((x) => x.subtype === "Highlight"), back.pages[0].annots);

  const lock = await SecurePDFDocument.load(a);
  lock.encrypt({ userPassword: "secret", ownerPassword: "owner" });
  const locked = await lock.save();
  const opened = await settle(loadForRender(locked));
  check("a file that needs a password: says to unlock it", friendlyPdfError(opened.error, "locked.pdf").message === "locked.pdf: This PDF is password-protected. Unlock it first.", opened.error?.message);
  const broken = await settle(loadForRender(new TextEncoder().encode("%PDF-1.7\nnot a pdf at all\n")));
  check("a broken file: says it isn't readable", /isn't a readable PDF/.test(friendlyPdfError(broken.error, "broken.pdf").message), broken.error?.message);

  // A file pdf.js reads but whose pages can't be read is named.
  const cut = a.slice(0, Math.floor(a.length * 0.6));
  const cutOpen = await settle(loadForRender(cut));
  if (cutOpen.value) {
    const lb = await loadForRender(b);
    const run = await settle(compareDocuments({ file: new Blob([cut]), name: "cut.pdf", loaded: cutOpen.value }, { file: new Blob([b as Uint8Array<ArrayBuffer>]), name: "b.pdf", loaded: lb }, { fonts }));
    check("a cut-off file is either compared or named in the error", !!run.value || /cut\.pdf|readable/.test(run.error?.message ?? ""), run.error?.message);
    lb.destroy();
    cutOpen.value.destroy();
  } else {
    check("a cut-off file is turned away when it opens", /readable|password/.test(friendlyPdfError(cutOpen.error).message), cutOpen.error?.message);
  }
}

// --- Pages without text, compared by how they look ----------------------------------------
if (!canvas) {
  console.log("SKIP  pages compared by how they look: node-canvas isn't installed");
} else {
  const a = await make([{ box: { x: 100, y: 500, w: 200, h: 150 } }, { lines: [sentence(1)] }]);
  const b = await make([{ box: { x: 160, y: 470, w: 200, h: 150 } }, { lines: [sentence(1)] }]);
  const r = await compare(a, b);
  check("a page with no text is listed as such", r.result.scanned.a.join() === "0" && r.result.scanned.b.join() === "0", r.result.scanned);
  const pic = r.result.changes.find((c) => c.kind === "picture");
  check("…and a drawing that moved is a change", r.result.changes.length === 1 && !!pic && pic.oldPage === 0 && pic.newPage === 0, describe(r));
  const box = pic?.areas?.b[0];
  // The squares, in displayed points: (100..300, 192..342) and (160..360, 222..372).
  check("…its area covers both places", !!box && box.x <= 104 && box.x + box.width >= 356 && box.y <= 196 && box.y + box.height >= 368, box);
  const back = await readBack(r.exports.markedB!);
  check("…boxed in the marked copy", back.pages[0].annots.some((x) => x.subtype === "Square" && /Looks different/.test(x.contents)), back.pages[0].annots);
  check("the report says those pages have no text", (await readBack(r.exports.report)).pages[0].text.includes("No text on"));

  const same = await compare(a, await make([{ box: { x: 100, y: 500, w: 200, h: 150 } }, { lines: [sentence(1)] }]));
  check("pages with no text that look the same: no differences", view.identical(same.result), describe(same));

  // A changed logo on a page with text: only seen when asked to look at every page.
  const c = await make([{ lines: [sentence(2)], box: { x: 400, y: 700, w: 60, h: 60, color: [0.1, 0.3, 0.8] } }]);
  const d = await make([{ lines: [sentence(2)], box: { x: 400, y: 700, w: 60, h: 60, color: [0.8, 0.1, 0.1] } }]);
  check("a changed picture on a text page isn't drawn by default", (await compare(c, d)).result.changes.length === 0);
  const looked = await compare(c, d, { looks: true });
  check("…and is found when every page is looked at", looked.result.changes.length === 1 && looked.result.changes[0].kind === "picture", describe(looked));

  // Cancel while pages are drawn.
  const ctl = new AbortController();
  const run = settle(compare(c, d, { looks: true, signal: ctl.signal, progress: (f) => f > 0.3 && ctl.abort() }));
  check("Cancel stops the comparison", isAbort((await run).error), (await run).error?.message);
}

// Cancel while reading, without node-canvas.
{
  const a = await make(Array.from({ length: 40 }, (_, i) => ({ lines: [sentence(i)] })));
  const ctl = new AbortController();
  let steps = 0;
  const run = await settle(compare(a, a, { signal: ctl.signal, progress: () => ++steps === 5 && ctl.abort() }));
  check("Cancel while reading pages stops at once", isAbort(run.error) && steps < 10, { steps, error: run.error?.message });
}

// --- Pixels -----------------------------------------------------------------------------
{
  const w = 64;
  const h = 48;
  const white = () => new Uint8ClampedArray(w * h * 4).fill(255);
  const a = white();
  const b = white();
  for (let y = 10; y < 20; y++) for (let x = 30; x < 50; x++) b.set([0, 0, 0, 255], (y * w + x) * 4);
  const d = pixelDiff(a, b, w, h);
  check("pixels: one area where a block was added", d.areas.length === 1 && d.areas[0].x <= 30 && d.areas[0].x + d.areas[0].width >= 50 && d.areas[0].y <= 10 && d.areas[0].y + d.areas[0].height >= 20, d.areas);
  check("pixels: identical pictures have none", pixelDiff(a, white(), w, h).areas.length === 0);
  const pic = differencePicture(b, a, w, h);
  const at = (x: number, y: number) => Array.from(pic.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
  // Taken out is red and striped: neighbouring bands differ.
  const stripes = new Set([at(30, 10).join(), at(34, 10).join(), at(38, 10).join()]);
  check("difference picture: taken out is red, striped", at(30, 10)[0] > 200 && stripes.size > 1, [...stripes]);
  const added = differencePicture(a, b, w, h);
  check("difference picture: put in is solid green", added[(12 * w + 32) * 4 + 1] > added[(12 * w + 32) * 4] && added[(12 * w + 40) * 4 + 1] === added[(12 * w + 32) * 4 + 1]);
}

// --- The page's logic ----------------------------------------------------------------------
{
  check("files: the first to the zone it was dropped on, a second to the other", JSON.stringify(view.placeFiles(["x", "y", "z"], "b")) === JSON.stringify([{ side: "b", file: "x" }, { side: "a", file: "y" }]));
  check("download names", JSON.stringify(view.exportNames("Contract v1.pdf", "Contract v2.PDF")) === JSON.stringify({ report: "Contract v2-comparison.pdf", markedA: "Contract v1-marked.pdf", markedB: "Contract v2-marked.pdf" }));
  check("download names: two files of one name are told apart", view.exportNames("a.pdf", "a.pdf").markedA === "a-original-marked.pdf" && view.exportNames("a.pdf", "a.pdf").markedB === "a-changed-marked.pdf");
  check("next and previous stay at the ends", view.stepChange(-1, 3, 1) === 0 && view.stepChange(-1, 3, -1) === 2 && view.stepChange(2, 3, 1) === 2 && view.stepChange(0, 3, -1) === 0 && view.stepChange(-1, 0, 1) === -1);
  const pairs = [{ a: 0, b: 0 }, { a: null, b: 1 }, { a: 1, b: 2 }];
  const ch = (kind: "added" | "removed", oldPage: number | null, newPage: number | null) => ({ kind, a: { start: 0, end: 0 }, b: { start: 0, end: 0 }, oldText: "x", newText: "y", oldPage, newPage });
  check("a change shows in its row", view.pairOfChange(ch("added", 1, 1), pairs) === 1 && view.pairOfChange(ch("removed", 1, 2), pairs) === 2);
  check("what is read out", view.describeChange(ch("added", 0, 1), 0, 4) === "Change 1 of 4, added: “y”, page 2 of the changed version.", view.describeChange(ch("added", 0, 1), 0, 4));
  const words = readWords([{ lines: [], chars: 0, width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }]).words;
  check("marks with no words to point at are skipped", marksFor("a", [ch("added", 0, 0)], words).length === 0);
}

// --- On the site --------------------------------------------------------------------------
{
  const tool = getTool("compare-pdf");
  check("registered once", !!tool && TOOLS.filter((t) => t.slug === "compare-pdf").length === 1);
  check("its own panel", !!tool && panelSpec(tool).kind === "compare");
  check("search finds it by what people type", ["compare", "compare pdf", "diff", "difference between two pdfs", "redline"].every((q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "compare-pdf")));
  check("in the sitemap", sitemap().some((u) => u.url.endsWith("/tools/compare-pdf")));
  check("related tools", relatedTools("compare-pdf").length === 4 && !relatedTools("compare-pdf").some((t) => t.slug === "compare-pdf"), relatedTools("compare-pdf").map((t) => t.slug));
  check("page limit per plan", LIMITS.guest.comparePages === LIMITS.free.comparePages && LIMITS.pro.comparePages > LIMITS.free.comparePages && LIMITS.team.comparePages === LIMITS.pro.comparePages);
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
