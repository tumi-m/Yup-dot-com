// Edit text: the page's text read into runs, and the saved file opened again
// with pdf.js and pdf-lib as independent readers. Where a run's operators
// draw only it, the old words must be gone from the page's text and from
// every decoded stream; where they can't safely be taken out, they must be
// covered and the report must say so. Either way the new words must be where
// the old ones were and the rest of the page as it was (compared pixel by
// pixel where a canvas is available). Hard inputs: turned pages, offset and
// mixed page sizes, TJ arrays with kerning, text that later text on the line
// is placed after, subset, full and CID fonts, Type3 fonts, form XObjects,
// invisible OCR text, one operator drawing two runs, form fields and links,
// owner-password and locked files, stale and unreadable content, broken
// files, a 300-page file, right-to-left and top-to-bottom text, and pages
// reordered or deleted after the edit.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { loadForRender } = await import("../lib/pdf/render.ts");
const { bakeAnnotations } = await import("../lib/pdf/bake.ts");
const { unchanged } = await import("../lib/pdf/edit-text/apply.ts");
const { readOperators } = await import("../lib/pdf/compress/lexer.ts");
const { stringsIn } = await import("../lib/pdf/redact/scan.ts");
const { guessFont, standardFont, fontLabel, undrawable } = await import("../lib/pdf/edit-text/fonts.ts");
const { editFromRun, ringColor, runStep, textNotice, pristine, runTransform } = await import("../lib/editor/text-edit.ts");
const { remapAnnotations, deleteMap, orderMap } = await import("../lib/editor/page-map.ts");
const { historyReducer } = await import("../lib/editor/history.ts");
const { reorderPages, deletePages } = await import("../lib/pdf/operations.ts");
const { friendlyPdfError } = await import("../lib/pdf/errors.ts");
const { TOOLS, getTool, relatedTools } = await import("../lib/tools.tsx");
const { filterTools } = await import("../components/tool-filter.ts");
const { panelSpec, placeholderSize } = await import("../components/tools/panel-spec.tsx");
const { PDF_ACTIONS } = await import("../components/landing/hero-actions.ts");
const { LIMITS } = await import("../lib/limits.ts");
const sitemap = (await import("../app/sitemap.ts")).default;

type EditableRun = import("../lib/pdf/edit-text/types.ts").EditableRun;
type TextEditAnnotation = import("../lib/editor/types.ts").TextEditAnnotation;
type Annotation = import("../lib/editor/types.ts").Annotation;
type TextEditReport = import("../lib/pdf/edit-text/apply.ts").TextEditReport;

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

// pdf.js prints a line for every glyph it has no font for; the checks are what matter here.
const warn = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
  warn(...args);
};

let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
} catch {
  canvasMod = null;
}
const FONTS = "./node_modules/pdfjs-dist/standard_fonts/";
/** Noto Sans from node_modules, as the browser fetches it from /vendor. */
const noto = async (name: string) =>
  new Uint8Array(readFileSync(`./node_modules/@fontsource/${name.startsWith("noto-sans-mono") ? "noto-sans-mono" : "noto-sans"}/files/${name}`));

// --- Helpers ---------------------------------------------------------------------------

/** Each page's editable runs, read as the editor reads them. */
async function runsOf(bytes: Uint8Array): Promise<EditableRun[][]> {
  const loaded = await loadForRender(bytes);
  try {
    const out: EditableRun[][] = [];
    for (let p = 1; p <= loaded.numPages; p++) out.push(await loaded.textRuns(p));
    return out;
  } finally {
    loaded.destroy();
  }
}

/** Each page's text items as a reader gets them: the string, and where its baseline starts on the page as shown. */
async function itemsOf(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: FONTS }).promise;
  const pages: { str: string; x: number; y: number; font: string; dx: number; dy: number }[][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    // Drawing the page loads its fonts, so their names can be read.
    await page.getOperatorList();
    const content = await page.getTextContent();
    const items = content.items
      .filter((it): it is typeof it & { str: string; transform: number[]; fontName: string } => "str" in it && it.str.trim() !== "")
      .map((it) => {
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        const len = Math.hypot(t[0], t[1]) || 1;
        const font = (page.commonObjs.has(it.fontName) ? (page.commonObjs.get(it.fontName) as { name?: string }).name : "") ?? "";
        return { str: it.str.trim(), x: t[4], y: t[5], font, dx: t[0] / len, dy: t[1] / len };
      });
    pages.push(items);
  }
  await doc.destroy();
  return pages;
}
const textOf = (items: { str: string }[]) => items.map((i) => i.str).join(" ");

/** Every decoded stream and every string in the file, as text: what someone digging in it would find. */
async function rawText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let all = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        const data = decodePDFRawStream(obj).decode();
        all += Buffer.from(data).toString("latin1") + "\n" + stringsIn(data) + "\n";
      } catch {
        // A picture.
      }
    }
    const walk = (o: unknown) => {
      if (o instanceof PDFString || o instanceof PDFHexString) all += o.decodeText() + "\n";
      else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v);
      else if (o instanceof PDFArray) o.asArray().forEach(walk);
    };
    walk(obj instanceof PDFRawStream ? obj.dict : obj);
  }
  return all;
}

let ids = 0;
/** An edit of `run` on page `page`, with changes. */
const edit = (run: EditableRun, page: number, change: Partial<TextEditAnnotation> = {}): TextEditAnnotation => ({
  ...editFromRun(run, page, "#ffffff", `e${++ids}`),
  ...change,
});

async function bake(bytes: Uint8Array, anns: Annotation[]) {
  let report: TextEditReport | null = null;
  const out = await bakeAnnotations(bytes, anns, { fonts: noto, onTextEdits: (r) => (report = r) });
  return { out, report: report as TextEditReport | null };
}

const find = (runs: EditableRun[], text: string) => runs.find((r) => r.text === text);

/** The page drawn at scale 1, or null without a canvas. */
async function render(bytes: Uint8Array, pageNumber: number) {
  if (!canvasMod) return null;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: FONTS }).promise;
  const page = await doc.getPage(pageNumber);
  const vp = page.getViewport({ scale: 1 });
  const c = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  await doc.destroy();
  return img;
}

/** Pixels that differ between two drawings of a page, outside the given boxes (with room round them). */
function diffOutside(a: ImageData, b: ImageData, boxes: EditableRun["box"][], pad = 2): number {
  let n = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (boxes.some((r) => x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad)) continue;
      const i = (y * a.width + x) * 4;
      if (Math.abs(a.data[i] - b.data[i]) > 24 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 24 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) n++;
    }
  }
  return n;
}

/** A page whose content and resources are written by hand. */
function rawPage(doc: PDFDocument, size: [number, number], ops: string, resources: Record<string, unknown> = {}) {
  const page = doc.addPage(size);
  const { context } = doc;
  const helv = context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  page.node.set(PDFName.of("Resources"), context.obj({ ...resources, Font: { F1: helv, ...((resources.Font as object) ?? {}) } }));
  page.node.set(PDFName.of("Contents"), context.register(context.flateStream(ops)));
  return page;
}

// --- The content reader ------------------------------------------------------------------
{
  const data = new TextEncoder().encode("q 1 0 0 1 5 5 cm BT /F1 12 Tf (a\\(b\\)\\101\\\nc) Tj [<4142> -120 (C)] TJ 2 0 Td 1 2 (d) \" ET BI /W 2 /H 1 /BPC 8 /CS /G ID xy EI Q");
  const ops: { op: string; start: number; end: number; strings: string[] }[] = [];
  const whole = readOperators(data, (op, operands, start, end) => {
    const strings = operands.flatMap((t) => (t.kind === "string" ? [t] : t.kind === "array" ? (t.items ?? []).filter((i) => i.kind === "string") : [])).map((t) => Buffer.from(t.bytes!).toString("latin1"));
    ops.push({ op, start, end, strings });
  });
  const text = (o: { start: number; end: number }) => Buffer.from(data.subarray(o.start, o.end)).toString("latin1");
  check("reader: every operator, in order, the inline image stepped over", whole && ops.map((o) => o.op).join(" ") === "q cm BT Tf Tj TJ Td \" ET Q", ops.map((o) => o.op));
  check("reader: literal strings with escapes, octal and a line joined", ops[4].strings[0] === "a(b)Ac", ops[4].strings);
  check("reader: hex strings and kerning arrays", ops[5].strings.join("|") === "AB|C" && text(ops[5]) === "[<4142> -120 (C)] TJ", text(ops[5]));
  check("reader: an operator starts at its first operand", text(ops[7]) === '1 2 (d) "' && text(ops[1]) === "1 0 0 1 5 5 cm");
  check("reader: an image with no end, or braces, can't be read with confidence", !readOperators(new TextEncoder().encode("BI /W 9 /H 9 /BPC 8 /CS /G ID abc"), () => {}) && !readOperators(new TextEncoder().encode("{ 1 0 0 1 0 0 cm }"), () => {}));
}

// --- Pure helpers -------------------------------------------------------------------------
{
  const grey = new Uint8ClampedArray(10 * 6 * 4);
  for (let i = 0; i < grey.length; i += 4) grey.set([240, 230, 200, 255], i);
  // Dark letters in the middle, a few dark pixels on the border.
  for (let y = 2; y < 4; y++) for (let x = 2; x < 8; x++) grey.set([10, 10, 10, 255], (y * 10 + x) * 4);
  grey.set([0, 0, 0, 255], 0);
  check("the colour round a run is the commonest on its border", ringColor(grey, 10, 6) === "#f0e6c8", ringColor(grey, 10, 6));
  check("see-through canvas is white paper", ringColor(new Uint8ClampedArray(4 * 4 * 4), 4, 4) === "#ffffff");
  check("keys move between runs and stop at the ends", runStep("ArrowDown", 0, 3) === 1 && runStep("ArrowRight", 2, 3) === 2 && runStep("ArrowUp", 0, 3) === 0 && runStep("Home", 2, 3) === 0 && runStep("End", 0, 3) === 2 && runStep("a", 0, 3) === null);
  check("standard fonts by kind, weight and slant", standardFont("serif", true, true) === "Times-BoldItalic" && standardFont("sans", false, true) === "Helvetica-Oblique" && standardFont("mono", true, false) === "Courier-Bold" && standardFont("serif", false, false) === "Times-Roman");
  check("font names for people", fontLabel("ABCDEF+Calibri-Bold") === "Calibri Bold" && fontLabel("Times-Roman") === "Times" && fontLabel("ArialMT") === "Arial", [fontLabel("ABCDEF+Calibri-Bold"), fontLabel("ArialMT")]);
  check("letters no font here draws", undrawable("Łódź 中文 😀 Ωmega").join("") === "中文😀", undrawable("Łódź 中文 😀 Ωmega"));
  const font = { name: "ABCDEF+Calibri", family: "sans" as const, bold: false, italic: false, subset: true, type3: false, program: true };
  check("a subset font: the closest standard font", guessFont(font, "Hello", false, false).name === "Helvetica" && !guessFont(font, "Hello", false, false).own);
  check("a whole font in the file, same style: its own", guessFont({ ...font, subset: false, name: "Calibri" }, "Hello", false, false).own && !guessFont({ ...font, subset: false, name: "Calibri" }, "Hello", true, false).own);
  check("letters beyond the standard fonts: Noto Sans", guessFont(font, "Łódź", false, false).noto && !guessFont(font, "Lodz", false, false).noto);
  const notice = textNotice({ removed: 1, covered: [{ page: 2, reason: "form" }, { page: 5, reason: "shared" }], fonts: [{ page: 1, from: "Calibri", to: "Helvetica" }, { page: 3, from: "Calibri", to: "Helvetica" }], missing: ["中"] });
  check("the save says plainly what is covered", notice.covered === "The old words of 2 changed lines on pages 2 and 5 are covered, not removed: they are still in the file under a box.", notice.covered);
  check("…which font was used instead", notice.fonts.join() === "New words on pages 1 and 3 use Helvetica instead of Calibri.", notice.fonts);
  check("…and which letters were left out", notice.missing === "Some letters can't be drawn here and were left out: 中.", notice.missing);
  check("nothing to say when every old word went", (() => { const n = textNotice({ removed: 3, covered: [], fonts: [], missing: [] }); return !n.covered && !n.fonts.length && !n.missing; })());
}

// --- A plain page: words taken out, the rest as it was ---------------------------------------
const helvetica = (doc: PDFDocument) => doc.embedFont(StandardFonts.Helvetica);
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([595, 842]);
  page.drawText("Quarterly Report", { x: 60, y: 770, size: 24, font: bold, color: rgb(0.1, 0.2, 0.5) });
  page.drawText("Sales grew by twelve percent this quarter.", { x: 60, y: 720, size: 12, font: times });
  page.drawText("The office in Durban opened in August.", { x: 60, y: 702, size: 12, font: times });
  page.drawRectangle({ x: 55, y: 600, width: 300, height: 30, color: rgb(1, 0.95, 0.7) });
  page.drawText("Total due: R 4 500", { x: 62, y: 610, size: 14, font: bold, color: rgb(0.6, 0.1, 0.1) });
  page.drawText("Signed by the manager", { x: 60, y: 500, size: 12, font });
  const bytes = await doc.save();
  const [runs] = await runsOf(bytes);
  check("runs: one per line, in drawing order", runs.map((r) => r.text).join("|") === "Quarterly Report|Sales grew by twelve percent this quarter.|The office in Durban opened in August.|Total due: R 4 500|Signed by the manager", runs.map((r) => r.text));
  const sales = find(runs, "Sales grew by twelve percent this quarter.")!;
  const total = find(runs, "Total due: R 4 500")!;
  const title = find(runs, "Quarterly Report")!;
  check("runs: size, colour and font as drawn", title.size === 24 && title.color === "#1a3380" && title.font.bold && title.font.family === "sans" && sales.font.family === "serif" && total.color === "#991a1a", [title.size, title.color, sales.font]);
  check("runs: boxes where the letters are (from the top left)", near(sales.box.x, 60) && near(sales.box.y + sales.box.height, 842 - 720 + 12 * 0.25, 1.5) && near(sales.box.width, times.widthOfTextAtSize(sales.text, 12), 1.5), sales.box);
  check("runs: each can be taken out", runs.every((r) => r.remove && !r.cover && !r.locked));
  // Shorter words, so the new ones stay inside the old box for the pixel check.
  const { out, report } = await bake(bytes, [edit(sales, 0, { text: "Sales grew a lot." }), edit(total, 0, { color: "#116633" })]);
  check("report: both taken out, none covered", report?.removed === 2 && report.covered.length === 0, report);
  const [after] = await itemsOf(out);
  const raw = await rawText(out);
  check("saved: the new words are on the page", textOf(after).includes("Sales grew a lot.") && textOf(after).includes("Total due: R 4 500"), textOf(after));
  check("saved: the old words are gone from the page's text", !textOf(after).includes("twelve"), textOf(after));
  check("saved: …and from every stream and string in the file", !raw.includes("twelve"), raw.indexOf("twelve"));
  const was = (await itemsOf(bytes))[0];
  const same = (s: string) => {
    const a = was.find((i) => i.str === s);
    const b = after.find((i) => i.str === s);
    return !!a && !!b && near(a.x, b.x, 0.01) && near(a.y, b.y, 0.01);
  };
  check("saved: the lines round it are where they were", ["Quarterly Report", "The office in Durban opened in August.", "Signed by the manager"].every(same));
  const moved = after.find((i) => i.str === "Sales grew a lot.");
  check("saved: the new words start on the old baseline", !!moved && near(moved.x, 60, 0.05) && near(moved.y, 842 - 720, 0.05), moved);
  const green = (await runsOf(out))[0].find((r) => r.text === "Total due: R 4 500");
  check("saved: a colour change, in the same font and place", !!green && green.color === "#116633" && green.font.name === "Helvetica-Bold" && near(green.box.x, total.box.x, 0.05), green && [green.color, green.font.name]);
  const before = await render(bytes, 1);
  const now = await render(out, 1);
  if (before && now) {
    check("saved: not a pixel changed outside the edited lines", diffOutside(before, now, [sales.box, total.box]) === 0, diffOutside(before, now, [sales.box, total.box]));
    // The yellow box under the total shows through: nothing was drawn over it (a cover would be white here).
    const yellow = (img: ImageData) => {
      let n = 0;
      for (let y = Math.ceil(total.box.y); y < total.box.y + total.box.height; y++) {
        for (let x = Math.ceil(total.box.x); x < total.box.x + total.box.width; x++) {
          const i = (y * img.width + x) * 4;
          if (img.data[i] > 240 && img.data[i + 2] < 200) n++;
        }
      }
      return n;
    };
    check("saved: what was under the old words shows (no box over them)", yellow(now) > yellow(before) * 0.9 && yellow(before) > 100, [yellow(before), yellow(now)]);
  } else check("pixels compared (needs the canvas package)", false, "canvas is missing");

  // Removing a line leaves nothing; an unchanged edit leaves the line alone.
  const removed = await bake(bytes, [edit(sales, 0, { text: "" }), edit(title, 0)]);
  const [left] = await itemsOf(removed.out);
  check("remove: the line's words are gone, the rest stays", !textOf(left).includes("Sales grew") && textOf(left).includes("Quarterly Report") && removed.report?.removed === 1, textOf(left));
  check("an edit that changes nothing changes nothing", unchanged(edit(title, 0)) && pristine(edit(title, 0)) && !pristine(edit(title, 0, { bold: false })));
}

// --- Text placed after text it follows on, and TJ kerning ------------------------------------------
{
  const doc = await PDFDocument.create();
  // One text object: a kerned TJ in black, then red words drawn on from where it stopped.
  rawPage(doc, [595, 842], "BT /F1 12 Tf 72 700 Td [(Ker) 120 (ned) -250 (line)] TJ 1 0 0 rg ( red tail) Tj ( more) Tj ET\nBT 0 g /F1 12 Tf 72 680 Td (Next line) Tj ET");
  const bytes = await doc.save();
  const [runs] = await runsOf(bytes);
  check("kerning: the TJ is one run, the red words another", runs.map((r) => `${r.text}:${r.color}`).join("|") === "Kerned line:#000000|red tail more:#ff0000|Next line:#000000", runs.map((r) => `${r.text}:${r.color}`));
  const kerned = runs[0];
  const { out, report } = await bake(bytes, [edit(kerned, 0, { text: "Kern" })]);
  const [was] = await itemsOf(bytes);
  const [after] = await itemsOf(out);
  check("kerning: taken out", report?.removed === 1 && !textOf(after).includes("Kerned"), [report, textOf(after)]);
  const red = await runsOf(out);
  const redTail = red[0].find((r) => r.text === "red tail more");
  // pdf.js reads the black and red words as one item, so the red run's own box is compared.
  check("kerning: the red words after it don't move", !!redTail && near(redTail.box.x, runs[1].box.x, 0.01) && near(redTail.box.y, runs[1].box.y, 0.01), [runs[1].box, redTail?.box]);
  check("kerning: the red words can still be taken out on their own", !!redTail?.remove);
  // The red tail's operators are carried on from the black ones: taking them out keeps "Next line" alone too.
  const second = await bake(bytes, [edit(runs[1], 0, { text: "blue", color: "#0000ff" })]);
  const [after2] = await itemsOf(second.out);
  check("words drawn on from others: taken out, the line before stays", second.report?.removed === 1 && textOf(after2).includes("Kerned line") && textOf(after2).includes("blue") && !textOf(after2).includes("tail"), textOf(after2));
}

// --- Turned pages, offset boxes and mixed sizes ------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const sizes: [number, number][] = [[595, 842], [612, 792], [420, 595], [842, 595]];
  for (const [i, rotation] of [0, 90, 180, 270].entries()) {
    const [w, h] = sizes[i];
    const page = doc.addPage([w + 100, h + 200]);
    page.setCropBox(60, 80, w, h);
    page.setRotation(degrees(rotation));
    page.drawText(`Turned ${rotation} first line`, { x: 120, y: 200 + 80, size: 14, font });
    page.drawText(`Turned ${rotation} second line`, { x: 120, y: 170 + 80, size: 14, font });
  }
  const bytes = await doc.save();
  const pages = await runsOf(bytes);
  const was = await itemsOf(bytes);
  const edits = pages.map((runs, p) => edit(runs.find((r) => r.text.endsWith("first line"))!, p, { text: `Page ${p + 1} changed` }));
  check("turned and offset pages: every line found, each can be taken out", pages.every((runs) => runs.length === 2 && runs.every((r) => r.remove)), pages.map((r) => r.map((x) => x.text)));
  const { out, report } = await bake(bytes, edits);
  const after = await itemsOf(out);
  check("turned and offset pages: all taken out", report?.removed === 4 && report.covered.length === 0, report);
  for (let p = 0; p < 4; p++) {
    const old = was[p].find((i) => i.str.endsWith("first line"))!;
    const neu = after[p].find((i) => i.str === `Page ${p + 1} changed`);
    const keep = (items: typeof was[0]) => items.find((i) => i.str.endsWith("second line"));
    check(`/Rotate ${p * 90} on a ${sizes[p].join("×")} box: new words where the old started, the same way up`, !!neu && near(neu.x, old.x, 0.05) && near(neu.y, old.y, 0.05) && near(neu.dx, old.dx, 1e-3) && near(neu.dy, old.dy, 1e-3), [old, neu]);
    check(`/Rotate ${p * 90}: the old words gone, the next line where it was`, !textOf(after[p]).includes("first line") && near(keep(was[p])!.x, keep(after[p])!.x, 0.01) && near(keep(was[p])!.y, keep(after[p])!.y, 0.01));
  }
  const box = pages[1][0].box;
  check("a turned page's run box stands up on the page as shown", box.height > box.width, box);
  // The overlay is placed by the run's own matrix: on a 90° page, a line going down the page.
  const t = runTransform(pages[1][0], 2);
  check("the editor turns the words with the line", /^matrix\(0, 2, /.test(t) || /^matrix\(-?0, -?2/.test(t), t);
}

// --- Fonts: subset, whole, CID; Noto Sans; letters left out --------------------------------------------
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const whole = await doc.embedFont(readFileSync(`${FONTS}LiberationSans-Regular.ttf`), { subset: false });
  const subset = await doc.embedFont(readFileSync(`${FONTS}LiberationSans-Regular.ttf`), { subset: true });
  const page = doc.addPage([595, 842]);
  page.drawText("Whole font line", { x: 60, y: 760, size: 12, font: whole });
  page.drawText("Another whole font line", { x: 60, y: 730, size: 12, font: whole });
  page.drawText("Subset font line", { x: 60, y: 700, size: 12, font: subset });
  const bytes0 = await doc.save();
  // Give the subset its usual name, with a six-letter tag.
  const named = await PDFDocument.load(bytes0);
  const type0 = named.context.lookup(subset.ref) as PDFDict;
  const kid = (type0.lookup(PDFName.of("DescendantFonts")) as PDFArray).lookup(0) as PDFDict;
  const tagged = PDFName.of(`ABCDEF+${(kid.get(PDFName.of("BaseFont")) as PDFName).decodeText()}`);
  for (const d of [type0, kid]) d.set(PDFName.of("BaseFont"), tagged);
  (kid.lookup(PDFName.of("FontDescriptor")) as PDFDict).set(PDFName.of("FontName"), tagged);
  const bytes = await named.save();
  const [runs] = await runsOf(bytes);
  const w = find(runs, "Whole font line")!;
  const w2 = find(runs, "Another whole font line")!;
  const s = find(runs, "Subset font line")!;
  check("fonts: a whole TrueType program is known, a tagged one is a subset", w.font.program && !w.font.subset && s.font.subset, [w.font, s.font]);
  check("CID fonts (2-byte codes): each can be taken out", !!w.remove && !!s.remove && w.remove.ops[0].codes.length === "Whole font line".length);
  const { out, report } = await bake(bytes, [edit(w, 0, { text: "Whole font, new words" }), edit(s, 0, { text: "Subset font, new words" }), edit(w2, 0, { text: "Łódź and Ωmega 中" })]);
  const [after] = await itemsOf(out);
  const fontOf = (str: string) => after.find((i) => i.str.startsWith(str))?.font ?? "";
  check("fonts: the whole font is used again when it has every letter", /LiberationSans/.test(fontOf("Whole font, new")), fontOf("Whole font, new"));
  check("fonts: a subset gives way to the closest standard font, and the report says so", fontOf("Subset font, new") === "Helvetica" && report!.fonts.some((f) => f.to === "Helvetica"), [fontOf("Subset font, new"), report!.fonts]);
  check("fonts: letters the whole font lacks send the line to Helvetica and Noto Sans", textOf(after).replace(/ /g, "").includes("Łódź") && textOf(after).replace(/ /g, "").includes("Ωmega") && after.some((i) => /NotoSans/.test(i.font)) && report!.fonts.some((f) => f.to === "Helvetica and Noto Sans"), [textOf(after), report!.fonts]);
  check("fonts: the whole font isn't reported as changed where it was used", !report!.fonts.some((f) => f.to === f.from) && report!.fonts.length === 2, report!.fonts);
  check("fonts: letters no font has are left out and named", report!.missing.join() === "中" && !textOf(after).includes("中"), report!.missing);
  check("fonts: all three taken out", report!.removed === 3 && !textOf(after).includes("Whole font line") && !textOf(after).includes("Subset font line"), textOf(after));
}

// --- What can only be covered ------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const { context } = doc;
  const helv = context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const form = context.register(context.stream("BT /F1 14 Tf 0 0 Td (Text inside a reused block) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 40], Resources: { Font: { F1: helv } } }));
  const glyph = context.register(context.flateStream("600 0 0 0 600 700 d1 50 0 500 700 re f"));
  const type3 = context.register(
    context.obj({
      Type: "Font",
      Subtype: "Type3",
      FontBBox: [0, 0, 600, 700],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { B: glyph, O: glyph, X: glyph },
      Encoding: { Type: "Encoding", Differences: [65, PDFName.of("B"), PDFName.of("O"), PDFName.of("X")] },
      FirstChar: 65,
      LastChar: 67,
      Widths: [600, 600, 600],
      Resources: {},
    })
  );
  rawPage(
    doc,
    [595, 842],
    [
      "BT /F1 12 Tf 60 780 Td (A plain line first) Tj ET",
      "q 1 0 0 1 60 740 cm /Fm Do Q",
      "BT /F1 12 Tf 60 700 Td [(Name:) -6000 (Thandi Nkosi)] TJ ET",
      "BT 3 Tr /F1 12 Tf 60 660 Td (Hidden searchable words) Tj 0 Tr ET",
      "BT /T3 20 Tf 60 620 Td (ABCA) Tj ET",
      "q 60 575 60 20 re W n BT /F1 12 Tf 60 580 Td (Clipped short words here) Tj ET Q",
      "BT /F1 12 Tf 60 540 Td (A plain line last) Tj ET",
    ].join("\n"),
    { XObject: { Fm: form }, Font: { F1: helv, T3: type3 } }
  );
  const bytes = await doc.save();
  const [runs] = await runsOf(bytes);
  const reasons = Object.fromEntries(runs.map((r) => [r.text, r.cover]));
  check("cover: text in a form XObject", reasons["Text inside a reused block"] === "form", reasons);
  check("cover: one operator drawing two runs", reasons["Name:"] === "shared" && reasons["Thandi Nkosi"] === "shared", reasons);
  check("cover: invisible text over a scan", reasons["Hidden searchable words"] === "hidden", reasons);
  check("cover: a Type3 font", Object.entries(reasons).some(([t, r]) => r === "type3" && t.length === 4), reasons);
  check("cover: text the page clips short", reasons["Clipped short words here"] === "clip", reasons);
  check("…plain lines can still be taken out", reasons["A plain line first"] === null && reasons["A plain line last"] === null, reasons);
  const covered = runs.filter((r) => r.cover);
  const name = find(runs, "Name:")!;
  // The label is taken away, so only the cover is left where it was.
  const { out, report } = await bake(bytes, [
    ...covered.filter((r) => r.text !== "Thandi Nkosi").map((r) => edit(r, 0, { text: r === name ? "" : `New ${r.cover}`, background: "#ffffff" })),
    edit(find(runs, "A plain line last")!, 0, { text: "Last, changed" }),
  ]);
  const [after] = await itemsOf(out);
  check("report: which were covered, and why, and the plain one taken out", report!.removed === 1 && report!.covered.map((c) => c.reason).sort().join() === "clip,form,hidden,shared,type3" && report!.covered.every((c) => c.page === 1), report);
  check("covered: the new words are on the page", ["New form", "New hidden", "New type3", "New clip"].every((t) => textOf(after).includes(t)), textOf(after));
  check("covered: honestly so: the old words are still in the file", textOf(after).includes("Text inside a reused block") && textOf(after).includes("Name:") && textOf(after).includes("Hidden searchable words"));
  check("shared: the other run drawn by the same operator survives", textOf(after).includes("Thandi Nkosi"));
  check("the plain line beside them was taken out", textOf(after).includes("Last, changed") && !textOf(after).includes("A plain line last"));
  const before = await render(bytes, 1);
  const now = await render(out, 1);
  if (before && now) {
    // The cover hides the old label: where "Name:" was drawn, the page is white now.
    const nb = name.box;
    const darkIn = (img: ImageData) => {
      let dark = 0;
      for (let y = Math.ceil(nb.y); y < nb.y + nb.height; y++) {
        for (let x = Math.ceil(nb.x); x < nb.x + nb.width; x++) if (img.data[(y * img.width + x) * 4] < 160) dark++;
      }
      return dark;
    };
    // The new words may reach past the old ones' boxes.
    const others = covered.map((r) => r.box).concat(find(runs, "A plain line last")!.box, ...(await runsOf(out))[0].filter((r) => r.text.startsWith("New ") || r.text.startsWith("Last")).map((r) => r.box));
    check("covered: the old label doesn't show through, the rest of the page as it was", darkIn(before) > 20 && darkIn(now) === 0 && diffOutside(before, now, others, 3) === 0, [darkIn(before), darkIn(now), diffOutside(before, now, others, 3)]);
  } else check("pixels compared (needs the canvas package)", false, "canvas is missing");
}

// --- Forms and links survive; owner passwords; locked, stale and broken files ------------------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const page = doc.addPage([595, 842]);
  page.drawText("Applicant name", { x: 60, y: 760, size: 12, font });
  page.drawText("Read the terms first", { x: 60, y: 700, size: 12, font });
  const field = doc.getForm().createTextField("applicant");
  field.addToPage(page, { x: 200, y: 750, width: 200, height: 24 });
  field.setText("Thandi");
  const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [60, 695, 200, 712], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/terms") } }));
  page.node.set(PDFName.of("Annots"), doc.context.obj([...(page.node.Annots()?.asArray() ?? []), link]));
  const bytes = await doc.save();
  const [runs] = await runsOf(bytes);
  check("forms: the field's value isn't offered as page text", !runs.some((r) => r.text.includes("Thandi")), runs.map((r) => r.text));
  const { out, report } = await bake(bytes, [edit(find(runs, "Applicant name")!, 0, { text: "Full name" })]);
  const reread = await PDFDocument.load(out);
  const annots = reread.getPage(0).node.Annots()?.asArray().map((r) => reread.context.lookup(r) as PDFDict) ?? [];
  check("forms: taken out, the field and its value kept", report?.removed === 1 && reread.getForm().getTextField("applicant").getText() === "Thandi");
  check("links: still there, still pointing where they did", annots.some((a) => a.get(PDFName.of("Subtype")) === PDFName.of("Link") && String((a.lookup(PDFName.of("A")) as PDFDict).get(PDFName.of("URI"))).includes("example.com/terms")));

  // Owner password only: read and changed like any other file.
  const plain = await (async () => {
    const d = await PDFDocument.create();
    d.addPage([595, 842]).drawText("Owner protected words", { x: 72, y: 700, size: 12, font: await helvetica(d) });
    return d.save();
  })();
  const owner = await SecurePDFDocument.load(plain);
  owner.encrypt({ ownerPassword: "owner-only", userPassword: "", permissions: { printing: "highResolution" } });
  const ownerBytes = await owner.save();
  const [ownerRuns] = await runsOf(ownerBytes);
  const ownerDone = await bake(ownerBytes, [edit(ownerRuns[0], 0, { text: "Changed protected words" })]);
  const [ownerAfter] = await itemsOf(ownerDone.out);
  check("owner password: its text is taken out and replaced", ownerDone.report?.removed === 1 && textOf(ownerAfter) === "Changed protected words", textOf(ownerAfter));
  const locked = await SecurePDFDocument.load(plain);
  locked.encrypt({ ownerPassword: "o", userPassword: "user" });
  const lockedRun = await settle(bake(await locked.save(), [edit(ownerRuns[0], 0, { text: "x" })]));
  check("a file that needs a password says to unlock it", lockedRun.error !== null && friendlyPdfError(lockedRun.error).message === "This PDF is password-protected. Unlock it first.", lockedRun.error?.message);
  const broken = await settle(bake(new TextEncoder().encode("not a pdf at all"), [edit(ownerRuns[0], 0)]));
  check("a file that isn't a PDF", broken.error !== null && friendlyPdfError(broken.error).message === "This file isn't a readable PDF.", broken.error?.message);

  // The page changed since its text was read: the plan no longer fits, so the words are covered.
  const changedDoc = await PDFDocument.create();
  rawPage(changedDoc, [595, 842], "BT /F1 12 Tf 72 760 (An extra line drawn first) Tj ET\nBT /F1 12 Tf 72 700 Td (Owner protected words) Tj ET");
  const stale = await bake(await changedDoc.save(), [edit(ownerRuns[0], 0, { text: "Stale plan" })]);
  check("stale: an operation that isn't the one read is never cut; the words are covered", stale.report?.removed === 0 && stale.report.covered[0]?.reason === "page", stale.report);
  check("stale: …the other line untouched", textOf((await itemsOf(stale.out))[0]).includes("Owner protected words") && textOf((await itemsOf(stale.out))[0]).includes("Stale plan"));
  // Content that can't be read whole (an inline image with no end): never rewritten.
  const badDoc = await PDFDocument.create();
  rawPage(badDoc, [595, 842], "BT /F1 12 Tf 72 700 Td (Owner protected words) Tj ET\nBI /W 40 /H 40 /BPC 8 /CS /G /F /AHx ID 00ff");
  const bad = await bake(await badDoc.save(), [edit(ownerRuns[0], 0, { text: "Unreadable page" })]);
  check("unreadable content: left as it is and covered", bad.report?.removed === 0 && bad.report.covered[0]?.reason === "page", bad.report);
}

// --- Right-to-left and top-to-bottom text can't be changed -----------------------------------------------
{
  const doc = await PDFDocument.create();
  const { context } = doc;
  // Codes A-D show Hebrew letters: "שלום".
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 4 beginbfchar <41> <05DD> <42> <05D5> <43> <05DC> <44> <05E9> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const hebrew = context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding", ToUnicode: context.register(context.flateStream(cmap)) }));
  doc.registerFontkit(fontkit);
  const cid = await doc.embedFont(readFileSync(`${FONTS}LiberationSans-Regular.ttf`), { subset: true });
  const page = rawPage(doc, [595, 842], "BT /HB 16 Tf 300 700 Td (ABCD) Tj ET\nBT /F1 12 Tf 60 650 Td (An ordinary line) Tj ET", { Font: { HB: hebrew } });
  page.drawText("Down the page", { x: 60, y: 600, size: 12, font: cid });
  const bytes0 = await doc.save();
  // The same CID font written top to bottom.
  const v = await PDFDocument.load(bytes0);
  for (const [, obj] of v.context.enumerateIndirectObjects()) if (obj instanceof PDFDict && obj.get(PDFName.of("Subtype")) === PDFName.of("Type0")) obj.set(PDFName.of("Encoding"), PDFName.of("Identity-V"));
  const bytes = await v.save();
  const [runs] = await runsOf(bytes);
  check("right to left: offered, but locked", runs.some((r) => r.locked === "rtl" && /[א-ת]/.test(r.text)), runs.map((r) => [r.text, r.locked]));
  check("top to bottom: offered, but locked", runs.some((r) => r.locked === "vertical"), runs.map((r) => [r.text, r.locked]));
  check("…the ordinary line isn't", find(runs, "An ordinary line")?.locked === null);
}

// --- Page operations: edits go with their pages ------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  for (let i = 1; i <= 3; i++) doc.addPage([595, 842]).drawText(`Line on page ${i}`, { x: 60, y: 700, size: 12, font });
  const bytes = await doc.save();
  const pages = await runsOf(bytes);
  const e3 = edit(pages[2][0], 2, { text: "Third page, changed" });
  const e1 = edit(pages[0][0], 0, { text: "First page, changed" });
  // Reorder: page 3 comes first. The edit moves with it, and its plan still fits the page.
  const order = [2, 0, 1];
  const moved = remapAnnotations([e1, e3], orderMap(order)) as TextEditAnnotation[];
  const reordered = await reorderPages(bytes, order);
  const { out, report } = await bake(reordered, moved);
  const after = await itemsOf(out);
  check("reordered: edits follow their pages", moved.find((a) => a.id === e3.id)!.page === 0 && moved.find((a) => a.id === e1.id)!.page === 1);
  check("reordered: each page's words taken out on the right page", report?.removed === 2 && textOf(after[0]) === "Third page, changed" && textOf(after[1]) === "First page, changed" && textOf(after[2]) === "Line on page 2", after.map(textOf));
  // Delete page 1: its edit goes with it, the others move up.
  const kept = remapAnnotations([e1, e3], deleteMap(0)) as TextEditAnnotation[];
  const deleted = await bake(await deletePages(bytes, [0]), kept);
  const left = await itemsOf(deleted.out);
  check("deleted: the page's edit goes with it", kept.length === 1 && kept[0].page === 1 && deleted.report?.removed === 1 && textOf(left[1]) === "Third page, changed" && textOf(left[0]) === "Line on page 2", left.map(textOf));
  // Undo after a page operation brings the edit back on the page it is now on.
  let h = historyReducer<Annotation[]>({ past: [], present: [], future: [], pending: null }, { type: "commit", next: [e3] });
  h = historyReducer(h, { type: "commit", next: [{ ...e3, text: "again" }] });
  h = historyReducer(h, { type: "remap", fn: (a) => remapAnnotations(a, orderMap(order)) });
  h = historyReducer(h, { type: "undo" });
  check("undo after a reorder: the earlier words, on the page they moved to", h.present.length === 1 && (h.present[0] as TextEditAnnotation).text === "Third page, changed" && h.present[0].page === 0, h.present);
}

// --- A long file --------------------------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  for (let i = 1; i <= 300; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Heading of page ${i}`, { x: 60, y: 760, size: 16, font });
    page.drawText(`Body text on page ${i} of the long file.`, { x: 60, y: 730, size: 11, font });
  }
  const bytes = await doc.save();
  const loaded = await loadForRender(bytes);
  const t0 = Date.now();
  const runs = await loaded.textRuns(250);
  await loaded.release(250);
  loaded.destroy();
  const read = Date.now() - t0;
  const t1 = Date.now();
  const { out, report } = await bake(bytes, [edit(runs[1], 249, { text: "Changed body on page 250." })]);
  const saved = Date.now() - t1;
  const after = await itemsOf(out);
  check(`300 pages: one page read (${read} ms) and the file written (${saved} ms)`, runs.length === 2 && report?.removed === 1 && read < 5000 && saved < 20000, { read, saved });
  check("300 pages: only that page changed", textOf(after[249]).includes("Changed body on page 250.") && !textOf(after[249]).includes("long file") && textOf(after[0]) === "Heading of page 1 Body text on page 1 of the long file." && textOf(after[299]).endsWith("page 300 of the long file."));
}

// --- Registered like the other tools; loads on demand; limits as they were --------------------------------
{
  const tool = getTool("edit-pdf-text");
  check("registered once, beside Edit PDF", !!tool && TOOLS.filter((t) => t.slug === "edit-pdf-text").length === 1 && tool.category === getTool("edit-pdf")!.category && !!tool.editor);
  check("its page opens the editor in Edit text", !!tool && JSON.stringify(panelSpec(tool)) === JSON.stringify({ kind: "editor", mode: "text" }) && placeholderSize("editor", "text") === "h-[244px]");
  check("search finds it by what people type", ["edit text", "change pdf text", "replace text", "fix typo", "pdf text editor"].every((q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "edit-pdf-text")), ["edit text", "replace text"].map((q) => filterTools(TOOLS, "all", q).map((t) => t.slug)));
  check("in the sitemap", sitemap().some((u) => u.url.endsWith("/tools/edit-pdf-text")));
  check("related tools are real, and Edit PDF and Redact PDF are among them", !!tool && relatedTools(tool.slug).every((t) => getTool(t.slug)) && relatedTools(tool.slug).some((t) => t.slug === "redact-pdf") && relatedTools("edit-pdf").some((t) => t.slug === "edit-pdf-text"));
  check("the homepage offers it for a PDF", PDF_ACTIONS.includes("edit-pdf-text"));
  const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const staticImport = (code: string, mod: RegExp) => [...code.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)].some((m) => mod.test(m[1]));
  check("the run reader loads when Edit text is first used", !staticImport(src("lib/pdf/render.ts"), /edit-text\/runs/) && /await import\("\.\/edit-text\/runs"\)/.test(src("lib/pdf/render.ts")));
  check("the writer (and fontkit) load only when text was changed", !staticImport(src("lib/pdf/bake.ts"), /edit-text\/apply|fontkit/) && /await import\("\.\/edit-text\/apply"\)/.test(src("lib/pdf/bake.ts")));
  check("the editor's own helpers bring no PDF code", !staticImport(src("lib/editor/text-edit.ts"), /./) && !staticImport(src("lib/pdf/edit-text/fonts.ts"), /./) && !staticImport(src("lib/pdf/edit-text/types.ts"), /./));
  check("Edit PDF Text keeps the editor's limits: the file size check and one edit a day free", /limits\.maxFileBytes/.test(src("components/tools/EditorLaunch.tsx")) && LIMITS.guest.editsPerDay === 1 && LIMITS.free.editsPerDay === 1 && LIMITS.pro.editsPerDay === Infinity);
  check("Edit PDF's page mentions Edit text and links to it", /EditPdfAbout/.test(src("app/tools/[slug]/page.tsx")) && /href="\/tools\/edit-pdf-text"/.test(src("components/tools/EditTextAbout.tsx")));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
