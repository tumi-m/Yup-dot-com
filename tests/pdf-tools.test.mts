process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import { friendlyPdfError } from "../lib/pdf/errors.ts";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { detectFormFields } from "../lib/pdf/forms.ts";
import { historyReducer, type HistoryAction, type HistoryState } from "../lib/editor/history.ts";
import type { Annotation } from "../lib/editor/types.ts";
import { extractTables, parseDocument } from "../lib/pdf/parse.ts";
import { jpegOrientation, sniffImage } from "../lib/pdf/images.ts";
import { imagesToPdfTool, mergeTool, pageNumbersTool, pdfToChunksTool, pdfToMarkdownTool, pdfToTextTool, rotateTool, parseRanges, rangeProblem, splitTool, watermarkTool, type ToolFile } from "../lib/pdf/toolkit.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

async function makePdf(sizes: [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach((s, i) => doc.addPage(s).drawText(`Page ${i + 1}`, { x: 20, y: 20, size: 12, font }));
  return doc.save();
}
const file = (bytes: Uint8Array | string, name: string) =>
  new File([typeof bytes === "string" ? bytes : (bytes.slice() as unknown as BlobPart)], name, { type: "application/pdf" });

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (err) {
    return friendlyPdfError(err).message;
  }
}

// --- Friendly errors -------------------------------------------------------
const a4 = await makePdf([[595, 842], [842, 595]]);
const locked = await (async () => {
  const d = await SecurePDFDocument.load(a4);
  d.encrypt({ userPassword: "pw", ownerPassword: "pw" });
  return d.save({ useObjectStreams: false });
})();

const encMsg = await errorOf(mergeTool([file(a4, "a.pdf"), file(locked, "locked.pdf")]));
check("merge: encrypted input names the file", encMsg === "locked.pdf: This PDF is password-protected. Unlock it first.", encMsg);
const fakeMsg = await errorOf(mergeTool([file(a4, "a.pdf"), file("hello world", "notes.pdf")]));
check("merge: non-PDF input is readable", fakeMsg === "notes.pdf: This file isn't a readable PDF.", fakeMsg);
const emptyMsg = await errorOf(mergeTool([file(new Uint8Array(), "empty.pdf"), file(a4, "a.pdf")]));
check("merge: empty file is readable", emptyMsg === "empty.pdf: This file isn't a readable PDF.", emptyMsg);
check(
  "pdf.js password error maps",
  friendlyPdfError(Object.assign(new Error("No password given"), { name: "PasswordException" })).message ===
    "This PDF is password-protected. Unlock it first."
);
check("pdf.js invalid structure maps", friendlyPdfError(new Error("Invalid PDF structure.")).message === "This file isn't a readable PDF.");
check("other errors pass through", friendlyPdfError(new Error("Use at least 4 characters.")).message === "Use at least 4 characters.");

// --- Split -----------------------------------------------------------------
check("ranges: reversed", JSON.stringify(parseRanges("3-1", 5)) === "[[0,1,2]]");
check("ranges: open-ended", JSON.stringify(parseRanges("4-", 5)) === "[[3,4]]");
check("ranges: clipped", JSON.stringify(parseRanges("4-9, 7", 5)) === "[[3,4]]");
check("ranges: spaces separate pages", JSON.stringify(parseRanges("1 3", 5)) === "[[0],[2]]");
check("ranges: spaces round a dash keep the range", JSON.stringify(parseRanges("1 - 3; 5", 5)) === "[[0,1,2],[4]]");
check("range problem: none for pages that exist", rangeProblem("1 3", 5) === null && rangeProblem("1-3, 5", 5) === null);
check("range problem: a range starting inside is cut, not refused", rangeProblem("2-10", 5) === null && JSON.stringify(parseRanges("2-10", 5)) === "[[1,2,3,4]]");
check("range problem: names the missing page", rangeProblem("1, 9", 5) === "Page 9 isn't in this PDF (5 pages).", rangeProblem("1, 9", 5));
check("range problem: a range past the end", rangeProblem("7-9", 5) === "Page 7 isn't in this PDF (5 pages).", rangeProblem("7-9", 5));
check("range problem: a part that doesn't parse", rangeProblem("1-3, x", 5) === "Use commas between ranges, like 1-3, 5.", rangeProblem("1-3, x", 5));
check("range problem: one page", rangeProblem("2", 1) === "Page 2 isn't in this PDF (1 page).", rangeProblem("2", 1));
const five = await makePdf([[595, 842], [595, 842], [595, 842], [595, 842], [595, 842]]);
const outOfRange = await errorOf(splitTool([file(five, "doc.pdf")], { mode: "ranges", ranges: "9" }));
check("split: out-of-range pages is an error, not the whole file", outOfRange === "Page 9 isn't in this PDF (5 pages).", outOfRange);
const dropped = await errorOf(splitTool([file(five, "doc.pdf")], { mode: "ranges", ranges: "1, 9" }));
check("split: a missing page isn't silently dropped", dropped === "Page 9 isn't in this PDF (5 pages).", dropped);
const typo = await errorOf(splitTool([file(five, "doc.pdf")], { mode: "ranges", ranges: "1-3, x" }));
check("split: a part that doesn't parse is an error", typo === "Use commas between ranges, like 1-3, 5.", typo);
const spaced = (await splitTool([file(five, "doc.pdf")], { mode: "ranges", ranges: "1 3" })) as ToolFile[];
check("split: '1 3' makes two files", spaced.length === 2, spaced.length);
const empty = await errorOf(splitTool([file(five, "doc.pdf")], { mode: "ranges", ranges: "" }));
check("split: no pages picked is still an error", empty === "Type the pages, like 1-3, 5.", empty);
const single = await makePdf([[595, 842]]);
const singleEmpty = await errorOf(splitTool([file(single, "one.pdf")], { mode: "ranges", ranges: "" }));
check("split: a 1-page PDF with no pages typed asks for pages", singleEmpty === "Type the pages, like 1-3, 5.", singleEmpty);
const parts = (await splitTool([file(five, "doc.pdf")], { mode: "ranges", ranges: "2-3, 5, 5" })) as ToolFile[];
check(
  "split: files named after source and pages, no collisions",
  JSON.stringify(parts.map((p) => p.filename)) === JSON.stringify(["doc-pages-2-3.pdf", "doc-page-5.pdf", "doc-page-5-2.pdf"]),
  parts.map((p) => p.filename)
);
const firstPart = await PDFDocument.load(await parts[0].blob.arrayBuffer());
check("split: range has its pages", firstPart.getPageCount() === 2);

// "1, 3" used to give two files with no way to keep them together.
const widths = await makePdf([501, 502, 503, 504, 505].map((w): [number, number] => [w, 842]));
const selected = (await splitTool([file(widths, "doc.pdf")], { mode: "one", ranges: "4, 1-2, 2" })) as ToolFile;
const selectedDoc = await PDFDocument.load(await selected.blob.arrayBuffer());
const sizes = selectedDoc.getPages().map((p) => p.getWidth()).join();
check("split one: the chosen pages in one PDF", !Array.isArray(selected) && selectedDoc.getPageCount() === 3, selectedDoc.getPageCount());
check("split one: in the order typed, each once", sizes === "504,501,502", sizes);
check("split one: named for a selection", selected.filename === "doc-selected.pdf", selected.filename);
const oneOut = await errorOf(splitTool([file(five, "doc.pdf")], { mode: "one", ranges: "2, 9" }));
check("split one: a page not in the PDF is an error", oneOut === "Page 9 isn't in this PDF (5 pages).", oneOut);
{
  const { PROCESSORS, fieldShown } = await import("../components/tools/processors.ts");
  const pagesField = PROCESSORS["split-pdf"].fields.find((f) => f.key === "ranges")!;
  const shownFor = ["ranges", "one", "every"].filter((mode) => fieldShown(pagesField, { mode }));
  check("split: Pages shows for both page modes", shownFor.join() === "ranges,one", shownFor);
  check("split: Pages starts empty, with an example", pagesField.default === "" && !!pagesField.placeholder);
  const { fieldHint } = await import("../components/tools/processors.ts");
  check("split: the per-range hint only in that mode", !!fieldHint(pagesField, { mode: "ranges" }) && !fieldHint(pagesField, { mode: "one" }));

  // Option problems are found before the job, so the page can mark the field.
  // A missing value waits for the cast; a value that was typed is said at once.
  const protect = PROCESSORS["protect-pdf"].problem!;
  const keyOf = (o: Record<string, string>) => {
    const p = protect(o);
    return p ? `${p.fields.join()}${p.live ? " (live)" : ""}: ${p.message}` : null;
  };
  check("protect: empty password", keyOf({ password: "", confirm: "" }) === "password: Please enter a password.");
  check("protect: short password, said on the cast while only it is typed", keyOf({ password: "s", confirm: "" }) === "password: Use at least 4 characters." && keyOf({ password: "sec", confirm: "" }) === "password: Use at least 4 characters.");
  check("protect: short password, said at once when the second is typed", keyOf({ password: "abc", confirm: "abc" }) === "password (live): Use at least 4 characters.");
  check("protect: mismatch marks the confirm field", keyOf({ password: "abcd", confirm: "abce" }) === "confirm (live): The passwords don't match.");
  check("protect: no mismatch said while the second is still being typed", keyOf({ password: "abcd", confirm: "ab" }) === "confirm: The passwords don't match." && keyOf({ password: "abcd", confirm: "" }) === "confirm: The passwords don't match.");
  check("protect: fine", keyOf({ password: "abcd", confirm: "abcd" }) === null);
  const mark = PROCESSORS["watermark-pdf"].problem!;
  check("watermark: blank text marks the text field, on the cast", mark({ text: "  " })?.fields.join() === "text" && !mark({ text: "  " })?.live && mark({ text: "DRAFT" }) === null);
  const split = PROCESSORS["split-pdf"].problem!;
  const noPages = split({ mode: "one", ranges: " " });
  check("split: no pages marks Pages, on the cast, as the tool says", noPages?.fields.join() === "ranges" && !noPages.live && noPages.message === empty, noPages);
  check("split: typed pages, or every page, have no problem", split({ mode: "ranges", ranges: "1-2" }) === null && split({ mode: "every", ranges: "" }) === null);
  const turn = PROCESSORS["rotate-pdf"].problem!;
  const noWhich = turn({ pages: "some", which: "" });
  check("rotate: no pages marks Which pages, on the cast", noWhich?.fields.join() === "which" && !noWhich.live && noWhich.message === empty, noWhich);
  check("rotate: all pages, or typed ones, have no problem", turn({ pages: "all", which: "" }) === null && turn({ pages: "some", which: "2" }) === null);
  const resize = PROCESSORS["resize-pdf"].problem!;
  const custom = resize({ size: "custom", width: "abc", height: "297", unit: "mm" });
  check("resize: a bad custom size marks both fields as it is typed", custom?.fields.join() === "width,height" && !!custom.live, custom);
  // Only fields that show are marked, in the order they show.
  const { problemFields } = await import("../components/tools/processors.ts");
  const sized = PROCESSORS["resize-pdf"].fields;
  const both = { fields: ["height", "width"], message: "x" };
  check("problem fields: shown ones, in field order", problemFields(both, sized, { size: "custom" }).join() === "width,height");
  check("problem fields: none while hidden", problemFields(both, sized, { size: "a4" }).length === 0 && problemFields(null, sized, {}).length === 0);
  check("problem fields: a hidden one is left out", problemFields({ fields: ["size", "width"], message: "x" }, sized, { size: "a4" }).join() === "size");
  check("resize: a paper size has no problem", resize({ size: "a4", width: "abc", height: "297", unit: "mm" }) === null);
  const flatten = PROCESSORS["flatten-pdf"].fields.find((f) => f.key === "mode")!;
  check("hints: a picked option's hint comes first", fieldHint(flatten, { mode: "images" }) === flatten.options!.find((o) => o.value === "images")!.hint);
  // The check and the tool agree, so nothing the field allows fails later.
  const tooShort = await errorOf((await import("../lib/pdf/toolkit.ts")).protectTool([file(five, "doc.pdf")], { password: "abc", confirm: "abc", printing: "yes", copying: "no" }));
  check("protect: the tool keeps the same rule", tooShort === protect({ password: "abc", confirm: "abc" })!.message, tooShort);
}
const oneEmpty = await errorOf(splitTool([file(five, "doc.pdf")], { mode: "one", ranges: "" }));
check("split one: no pages picked is an error", oneEmpty === "Type the pages, like 1-3, 5.", oneEmpty);

// --- Stamps land where the reader sees the page ------------------------------
const odd = await (async () => {
  const d = await PDFDocument.create();
  d.addPage([595, 842]);
  d.addPage([595, 842]).setRotation(degrees(90));
  const p = d.addPage([400, 300]);
  p.setMediaBox(100, 100, 400, 300);
  d.addPage([595, 842]).setRotation(degrees(270));
  return d.save();
})();

/** Text items of a page in displayed (viewport) coordinates, y from the top. */
async function displayedText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items as { str: string; transform: number[] }[])
      .filter((t) => t.str.trim())
      .map((t) => {
        const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
        // Direction of the baseline on screen: 0 means upright, left-to-right.
        const [x2, y2] = vp.convertToViewportPoint(t.transform[4] + t.transform[0], t.transform[5] + t.transform[1]);
        return { str: t.str, x, y, upright: x2 > x && Math.abs(y2 - y) < 0.01 * Math.abs(x2 - x) + 0.01 };
      });
    pages.push({ w: vp.width, h: vp.height, items });
  }
  doc.destroy();
  return pages;
}

const numbered = await pageNumbersTool([file(odd, "odd.pdf")], { position: "bottom-right", format: "n", fontSize: "12" });
const numberedPages = await displayedText(new Uint8Array(await numbered.blob.arrayBuffer()));
numberedPages.forEach((p, i) => {
  const label = p.items.find((t) => t.str === String(i + 1));
  check(
    `page numbers: page ${i + 1} number is upright, bottom-right, on the page`,
    !!label && label.upright && label.x > p.w * 0.6 && label.x < p.w && label.y > p.h * 0.85 && label.y <= p.h,
    { label, w: p.w, h: p.h }
  );
});

const marked = await watermarkTool([file(odd, "odd.pdf")], { text: "CONFIDENTIAL", opacity: "0.3", color: "#ff0000", fontSize: "90" });
const markedPages = await displayedText(new Uint8Array(await marked.blob.arrayBuffer()));
markedPages.forEach((p, i) => {
  const mark = p.items.find((t) => t.str === "CONFIDENTIAL");
  // Rotated 45° about its start, centred: the start sits in the lower-left quadrant.
  check(
    `watermark: page ${i + 1} centred on the visible page`,
    !!mark && mark.x > 0 && mark.x < p.w / 2 && mark.y > p.h / 2 && mark.y < p.h,
    { mark, w: p.w, h: p.h }
  );
});
const nonLatin = await errorOf(watermarkTool([file(odd, "odd.pdf")], { text: "Черновик", opacity: "0.3", color: "#ff0000", fontSize: "60" }));
check("watermark: non-Latin text doesn't surface a font-encoding error", !/WinAnsi/.test(nonLatin), nonLatin);
const blankMark = await errorOf(watermarkTool([file(odd, "odd.pdf")], { text: "  ", opacity: "0.3", color: "#ff0000", fontSize: "60" }));
check("watermark: blank text asks for text instead of stamping a default", /watermark text/.test(blankMark), blankMark);

// --- Text tools on a PDF with no text layer (a scan) --------------------------
{
  const d = await PDFDocument.create();
  d.addPage([300, 300]).drawRectangle({ x: 20, y: 20, width: 100, height: 100 });
  const noText = file(await d.save(), "scan.pdf");
  for (const [name, run] of [
    ["text", () => pdfToTextTool([noText])],
    ["markdown", () => pdfToMarkdownTool([noText])],
    ["chunks", () => pdfToChunksTool([noText], { maxChars: "1200" })],
  ] as const) {
    const msg = await errorOf(run());
    check(`${name}: a PDF without text fails with the OCR hint, not an empty file`, /OCR/.test(msg), msg);
  }
}

// --- Images -> PDF -----------------------------------------------------------
// 16x8 JPEG (red | blue) tagged EXIF orientation 6, as phones save portrait shots.
const JPEG_EXIF6 = "/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYxLjMuMTAwAP/bAEMACAoKCwoLDQ0NDQ0NEA8QEBAQEBAQEBAQEBISEhUVFRISEhAQEhIUFBUVFxcXFRUVFRcXGRkZHh4cHCMjJCsrM//EAE8AAQAAAAAAAAAAAAAAAAAAAAYBAQAAAAAAAAAAAAAAAAAAAAYQAQAAAAAAAAAAAAAAAAAAAAARAAMBAQEAAAAAAAAAAAAAAAAGhMNFRP/AABEIAAgAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/ABYgXiBUhdGbYbOvhoyP/9k=";
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const fromB64 = (b: string) => new Uint8Array(Buffer.from(b, "base64"));
const img = (bytes: Uint8Array | string, name: string, type: string) =>
  new File([typeof bytes === "string" ? bytes : (bytes.slice() as unknown as BlobPart)], name, { type });

check("exif orientation read", jpegOrientation(fromB64(JPEG_EXIF6)) === 6);
check("sniff png", sniffImage(fromB64(PNG_1PX)) === "png");
const imagesPdf = await imagesToPdfTool(
  [img(fromB64(JPEG_EXIF6), "phone.jpg", "image/jpeg"), img(fromB64(PNG_1PX), "really-a-png.jpg", "image/jpeg")],
  { pageSize: "fit", margin: "0" }
);
const imagesDoc = await PDFDocument.load(await imagesPdf.blob.arrayBuffer());
const s0 = imagesDoc.getPage(0).getSize();
check("jpg-to-pdf: EXIF-rotated photo gets a portrait page", s0.width === 8 && s0.height === 16, s0);
check("jpg-to-pdf: PNG named .jpg still converts", imagesDoc.getPageCount() === 2);
const notImage = await errorOf(imagesToPdfTool([img("GIF89a....", "anim.jpg", "image/jpeg")], { pageSize: "fit", margin: "0" }));
check("jpg-to-pdf: non-image explains itself", notImage === "anim.jpg: use a JPG or PNG image.", notImage);

// --- Editor annotations land where they were placed on screen ---------------
{
  // Placed 40pt from the top-left of the page as displayed, on every page kind.
  const anns: Annotation[] = [0, 1, 2, 3].flatMap((page) => [
    { id: `t${page}`, page, type: "text", x: 40, y: 40, width: 200, height: 20, text: `Note ${page + 1}`, fontSize: 12, color: "#111111", bold: false },
    { id: `l${page}`, page, type: "link", x: 40, y: 100, width: 120, height: 20, url: "https://example.com", targetPage: null },
    { id: `f${page}`, page, type: "field", field: "text", name: `name${page}`, value: "", x: 40, y: 160, width: 150, height: 22, fontSize: 12, options: [] },
  ]) as Annotation[];
  const baked = await bakeAnnotations(odd, anns);
  const pages = await displayedText(baked);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: baked.slice(), verbosity: 0 }).promise;
  for (let i = 0; i < 4; i++) {
    const t = pages[i].items.find((it) => it.str === `Note ${i + 1}`);
    check(`editor: text on page ${i + 1} stays top-left and upright`, !!t && t.upright && Math.abs(t.x - 40) < 2 && Math.abs(t.y - 52) < 4, t);
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: 1 });
    const annots = await page.getAnnotations();
    const box = (subtype: string) => {
      const a = annots.find((x: { subtype: string }) => x.subtype === subtype);
      if (!a) return null;
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
      return [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)].map(Math.round);
    };
    check(`editor: link on page ${i + 1} covers its spot`, JSON.stringify(box("Link")) === "[40,100,120,20]", box("Link"));
    const field = box("Widget");
    check(
      `editor: field on page ${i + 1} covers its spot`,
      !!field && [40, 160, 150, 22].every((v, k) => Math.abs(field[k] - v) <= 1.5),
      field
    );
  }
  doc.destroy();

  // Reopening the file in the editor shows existing fields where they are.
  const detected = await detectFormFields(baked);
  for (let i = 0; i < 4; i++) {
    const f = detected.find((d) => d.page === i);
    check(
      `editor: existing field on page ${i + 1} overlays its spot`,
      !!f && [f.x, f.y, f.width, f.height].every((v, k) => Math.abs(v - [40, 160, 150, 22][k]) <= 1.5),
      f && [f.x, f.y, f.width, f.height]
    );
  }
}

// --- Editor undo/redo -------------------------------------------------------
{
  type S = HistoryState<string[]>;
  // React may run reducers twice (StrictMode); the result must not change.
  const twice = (st: S, a: HistoryAction<string[]>) => {
    historyReducer(st, a);
    return historyReducer(st, a);
  };
  let st: S = { past: [], present: [], future: [], pending: null };
  st = twice(st, { type: "commit", next: (p) => [...p, "text"] });
  st = twice(st, { type: "begin" });
  st = twice(st, { type: "live", next: (p) => [...p, "draw"] });
  st = twice(st, { type: "live", next: (p) => p.map((x) => (x === "draw" ? "draw2" : x)) });
  st = twice(st, { type: "end" });
  check("history: a gesture is one entry", st.past.length === 2 && st.present.join() === "text,draw2", st);
  st = twice(st, { type: "undo" });
  check("history: undo", st.present.join() === "text" && st.future.length === 1, st);
  st = twice(st, { type: "redo" });
  check("history: redo restores", st.present.join() === "text,draw2" && st.future.length === 0 && st.past.length === 2, st);
  st = twice(st, { type: "undo" });
  st = twice(st, { type: "undo" });
  st = twice(st, { type: "redo" });
  check("history: undo twice, redo once", st.present.join() === "text" && st.future.length === 1, st);
}

// --- Rotate keeps existing rotation and names the result after the source ----
{
  const rotated = await rotateTool([file(odd, "scan.pdf")], { angle: "90" });
  const doc = await PDFDocument.load(await rotated.blob.arrayBuffer());
  check("rotate: adds to each page's rotation", doc.getPages().map((p) => p.getRotation().angle).join() === "90,180,90,0");
  check("rotate: result named after source", rotated.filename === "scan-rotated.pdf", rotated.filename);
  const some = await rotateTool([file(odd, "scan.pdf")], { angle: "180", pages: "some", which: "2, 4-" });
  const someDoc = await PDFDocument.load(await some.blob.arrayBuffer());
  check("rotate: only the pages picked", someDoc.getPages().map((p) => p.getRotation().angle).join() === "0,270,0,90", someDoc.getPages().map((p) => p.getRotation().angle));
  const all = await rotateTool([file(odd, "scan.pdf")], { angle: "90", pages: "all", which: "2" });
  const allDoc = await PDFDocument.load(await all.blob.arrayBuffer());
  check("rotate: all pages ignores the page list", allDoc.getPages().map((p) => p.getRotation().angle).join() === "90,180,90,0");
  const outside = await errorOf(rotateTool([file(odd, "scan.pdf")], { angle: "90", pages: "some", which: "7" }));
  check("rotate: a page not in the PDF is an error", outside === "Page 7 isn't in this PDF (4 pages).", outside);
  const none = await errorOf(rotateTool([file(odd, "scan.pdf")], { angle: "90", pages: "some", which: " " }));
  check("rotate: no pages picked is an error", none === "Type the pages, like 1-3, 5.", none);
}

// --- Tightly padded tables (HTML/Word exports) -------------------------------
{
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([595, 842]);
  const size = 12;
  // Justified prose drawn word by word, with stretched (but word-sized) gaps.
  const prose = "The quarterly figures below were compiled by the regional offices and checked twice.";
  for (let line = 0; line < 3; line++) {
    let x = 40;
    for (const word of prose.split(" ")) {
      page.drawText(word, { x, y: 780 - line * 16, size, font });
      x += font.widthOfTextAtSize(word, size) + size * 0.45;
    }
  }
  // Columns only ~0.8em apart; header labels centred over their columns.
  const cols = [40, 135, 185, 235];
  const widths = [86, 42, 42, 42];
  const rows = [
    ["Region", "Q1", "Q2", "Q3"],
    ["Gauteng", "1,200", "1,350", "1,410"],
    ["Western Cape", "980", "1,020", "1,100"],
    ["Eastern Cape", "540", "575", "600"],
  ];
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const w = font.widthOfTextAtSize(cell, size);
      const x = r === 0 && c > 0 ? cols[c] + (widths[c] - w) / 2 : cols[c];
      page.drawText(cell, { x, y: 700 - r * 20, size, font });
    })
  );
  const parsed = await parseDocument(await d.save());
  const tables = extractTables(parsed);
  check(
    "tables: tight columns become separate cells",
    tables.length === 1 && JSON.stringify(tables[0].rows) === JSON.stringify(rows),
    tables.map((t) => t.rows)
  );
  const prosePara = parsed.blocks.find((b) => b.type === "paragraph");
  check("tables: justified prose stays a paragraph", !!prosePara && prosePara.text.startsWith("The quarterly figures"), parsed.blocks[0]);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
