// Organize PDF, Delete pages and Extract pages. The page list is changed
// with plain functions (lib/pdf/pages/plan.ts) and the file is written once
// at the end (lib/pdf/pages/index.ts). Each result is opened again with
// pdf.js and pdf-lib: page order, sizes, rotation, text, form fields, links,
// bookmarks and notes, on rotated, mixed-size, restricted, locked, long and
// broken files.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, type PDFPage, type PDFRef } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import {
  appendSource,
  dropIndex,
  gridStep,
  idsBetween,
  insertBlank,
  moveItems,
  pageListText,
  parsePageList,
  planFor,
  removeItems,
  resultName,
  reverseItems,
  rotateItems,
  unchanged,
  type PlanItem,
} from "../lib/pdf/pages/plan.ts";
import { buildPages } from "../lib/pdf/pages/index.ts";
import { buildPagesFile } from "../lib/pdf/pages/off-thread.ts";
import { ENCRYPTED_MESSAGE, UNREADABLE_MESSAGE } from "../lib/pdf/errors.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
async function failure(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "no error";
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const ids = (plan: PlanItem[]) => plan.map((p) => p.id).join(" ");
const set = (...list: string[]) => new Set(list);

// --- The page list -------------------------------------------------------------
{
  const plan = planFor(0, 5);
  check("plan: every page in order", ids(plan) === "0:0 0:1 0:2 0:3 0:4" && unchanged(plan, 5));
  check("move one page forward", ids(moveItems(plan, set("0:0"), 2)) === "0:1 0:2 0:0 0:3 0:4");
  check("move one page back", ids(moveItems(plan, set("0:3"), 0)) === "0:3 0:0 0:1 0:2 0:4");
  check("move past the end stops at the end", ids(moveItems(plan, set("0:1"), 99)) === "0:0 0:2 0:3 0:4 0:1");
  check("move picked pages together, in their order", ids(moveItems(plan, set("0:4", "0:1"), 0)) === "0:1 0:4 0:0 0:2 0:3");
  check("a move that changes nothing keeps the same list", moveItems(plan, set("0:2"), 2) === plan);
  const drop = (moving: string[], target: string) => ids(moveItems(plan, set(...moving), dropIndex(plan, set(...moving), target)));
  check("drop a page on a later page: it goes after it", drop(["0:0"], "0:2") === "0:1 0:2 0:0 0:3 0:4");
  check("drop a page on an earlier page: it goes before it", drop(["0:4"], "0:1") === "0:0 0:4 0:1 0:2 0:3");
  check("drop picked pages on a later page", drop(["0:0", "0:1"], "0:3") === "0:2 0:3 0:0 0:1 0:4");
  check("drop picked pages on one of them: they gather there", drop(["0:0", "0:3"], "0:3") === "0:1 0:2 0:0 0:3 0:4", drop(["0:0", "0:3"], "0:3"));
  const turned = rotateItems(rotateItems(plan, set("0:1"), 90), set("0:1", "0:2"), -90);
  check("rotate adds up and turns left too", turned[1].rotate === 0 && turned[2].rotate === 270 && !unchanged(turned, 5), turned.map((p) => p.rotate));
  check("remove pages", ids(removeItems(plan, set("0:0", "0:4"))) === "0:1 0:2 0:3");
  const { plan: withBlank, id } = insertBlank(plan, 1, { width: 300, height: 200 });
  check("a blank page goes after the page asked", withBlank[2].id === id && withBlank[2].kind === "blank" && withBlank.length === 6);
  check("a blank page can go first", insertBlank(plan, -1, { width: 1, height: 1 }).plan[0].kind === "blank");
  check("reverse the whole document", ids(reverseItems(plan)) === "0:4 0:3 0:2 0:1 0:0");
  check("reverse only the picked pages", ids(reverseItems(plan, set("0:0", "0:2", "0:3"))) === "0:3 0:1 0:2 0:0 0:4");
  check("one picked page reverses the whole document", ids(reverseItems(plan, set("0:2"))) === "0:4 0:3 0:2 0:1 0:0");
  check("shift-click range either way round", idsBetween(plan, "0:3", "0:1").join() === "0:1,0:2,0:3");
  check("arrows step through the grid", gridStep(5, "ArrowRight", 10, 4) === 6 && gridStep(5, "ArrowUp", 10, 4) === 1 && gridStep(1, "ArrowUp", 10, 4) === 0 && gridStep(8, "ArrowDown", 10, 4) === 9);
  check("Home, End and other keys", gridStep(5, "Home", 10, 4) === 0 && gridStep(5, "End", 10, 4) === 9 && gridStep(5, "a", 10, 4) === null);
  check("another file's pages go at the end", ids(appendSource(planFor(0, 2), 1, 2)) === "0:0 0:1 1:0 1:1");

  const p = (text: string, n = 12) => parsePageList(text, n);
  check("ranges: 2-4, 7", p("2-4, 7").pages.join() === "1,2,3,6" && p("2-4, 7").problem === null);
  check("ranges: spaces, dashes and en dashes", p("2 - 4 7  9–10").pages.join() === "1,2,3,6,8,9", p("2 - 4 7  9–10"));
  check("ranges: open ends and reversed", p("10-, -2, 6-5").pages.join() === "0,1,4,5,9,10,11", p("10-, -2, 6-5").pages);
  check("ranges: repeats count once", p("3, 3, 2-3").pages.join() === "1,2");
  check("ranges: a word is named", p("2, abc").problem?.includes('"abc"') === true && p("2, abc").pages.join() === "1", p("2, abc"));
  check("ranges: pages past the end are named", p("11-14").problem === "Pages go from 1 to 12." && p("11-14").pages.join() === "10,11", p("11-14"));
  check("ranges: page 0 is named", p("0").problem === "Pages go from 1 to 12.");
  check("ranges: empty picks nothing, quietly", p("  ").pages.length === 0 && p("").problem === null);
  check("ranges: a lone dash is a typo", p("-").problem !== null);
  check("written back as people type it", pageListText([6, 1, 2, 3, 9]) === "2-4, 7, 10" && pageListText([]) === "");
  check(
    "file names",
    resultName("Report.PDF", "organize") === "Report-organized.pdf" &&
      resultName("a.pdf", "delete") === "a-trimmed.pdf" &&
      resultName("a.pdf", "extract", [3, 1, 2]) === "a-pages-2-4.pdf" &&
      resultName("a.pdf", "extract", [4]) === "a-page-5.pdf" &&
      resultName("a.pdf", "extract", [0, 4]) === "a-extracted.pdf" &&
      resultName(".pdf", "organize") === "document-organized.pdf"
  );
}

// --- A document with everything --------------------------------------------------
// Five pages of mixed sizes, page 3 shown turned 90°. A form field on pages 1
// and 3 with values, a sticky note on page 4, links from page 1 to pages 2
// and 5, and bookmarks to pages 2 and 4.
const SIZES: [number, number][] = [
  [612, 792],
  [595, 842],
  [400, 600],
  [842, 595],
  [300, 300],
];
async function richPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.setTitle("Field Guide");
  const font = await d.embedFont(StandardFonts.Helvetica);
  const pages: PDFPage[] = SIZES.map(([w, h], i) => {
    const page = d.addPage([w, h]);
    page.drawText(`Page ${i + 1} words`, { x: 30, y: h - 60, size: 16, font });
    return page;
  });
  pages[2].setRotation(degrees(90));
  const form = d.getForm();
  const name = form.createTextField("name");
  name.addToPage(pages[0], { x: 30, y: 400, width: 200, height: 20 });
  name.setText("Thandi");
  const city = form.createTextField("city");
  city.addToPage(pages[2], { x: 30, y: 200, width: 200, height: 20 });
  city.setText("Gqeberha");
  pages[3].node.addAnnot(
    d.context.register(d.context.obj({ Type: "Annot", Subtype: "Text", Rect: [50, 50, 70, 70], Contents: PDFString.of("Check this page") }))
  );
  const link = (to: number, y: number) =>
    pages[0].node.addAnnot(
      d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [30, y, 200, y + 12], Border: [0, 0, 0], Dest: [pages[to].ref, "Fit"] }))
    );
  link(1, 300);
  link(4, 280);
  const outlines = d.context.nextRef();
  const [b2, b4] = [d.context.nextRef(), d.context.nextRef()];
  const mark = (ref: PDFRef, title: string, page: number, more: object) =>
    d.context.assign(ref, d.context.obj({ Title: PDFString.of(title), Dest: [pages[page].ref, "Fit"], Parent: outlines, ...more }));
  mark(b2, "Two", 1, { Next: b4 });
  mark(b4, "Four", 3, { Prev: b2 });
  d.context.assign(outlines, d.context.obj({ Type: "Outlines", First: b2, Last: b4, Count: 2 }));
  d.catalog.set(PDFName.of("Outlines"), outlines);
  return d.save();
}

/** What a reader makes of a result. */
async function read(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: { text: string; size: string; rotate: number; links: (number | string)[]; notes: string[] }[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("").trim();
    const vp = page.getViewport({ scale: 1 });
    const links: (number | string)[] = [];
    const notes: string[] = [];
    for (const a of await page.getAnnotations()) {
      if (a.subtype === "Link") {
        links.push(a.dest ? await doc.getPageIndex(a.dest[0]).then((i) => i + 1, () => "nowhere") : "nowhere");
      }
      if (a.subtype === "Text") notes.push(a.contentsObj?.str ?? "");
    }
    pages.push({ text, size: `${Math.round(vp.width)}x${Math.round(vp.height)}`, rotate: page.rotate, links, notes });
  }
  const outline = (await doc.getOutline()) ?? [];
  const marks: string[] = [];
  for (const o of outline) {
    const dest = typeof o.dest === "string" ? await doc.getDestination(o.dest) : o.dest;
    marks.push(`${o.title}@${dest ? (await doc.getPageIndex(dest[0])) + 1 : "?"}`);
  }
  const fields = await doc.getFieldObjects();
  // A field's first entry is the field itself; its widgets, with the value and page, follow.
  const fieldValues = Object.fromEntries(
    Object.entries(fields ?? {}).map(([k, list]) => {
      const widget = list.find((w) => (w.page ?? -1) >= 0) ?? list[0];
      return [k, `${widget.value}@${(widget.page ?? -1) + 1}`];
    })
  );
  const title = ((await doc.getMetadata()).info as { Title?: string }).Title;
  await doc.destroy();
  return { pages, marks, fields: fieldValues, title };
}

const rich = await richPdf();
const words = (r: Awaited<ReturnType<typeof read>>) => r.pages.map((p) => p.text.replace(/Page (\d) words/, "$1") || "blank").join(" ");

// --- Organize --------------------------------------------------------------------
{
  // Reverse, turn page 2, a blank after it, take out page 5, add a 2-page file before the end.
  const other = await (async () => {
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) d.addPage([500, 500]).drawText(`Extra ${i + 1}`, { x: 30, y: 440, size: 16, font });
    const zip = d.getForm().createTextField("name");
    zip.addToPage(d.getPage(1), { x: 30, y: 100, width: 100, height: 20 });
    zip.setText("Other file");
    return d.save();
  })();
  let plan = planFor(0, 5);
  plan = reverseItems(plan); // 5 4 3 2 1
  plan = removeItems(plan, set("0:4")); // 4 3 2 1
  plan = rotateItems(plan, set("0:1"), 90); // page 2 turned
  plan = insertBlank(plan, 2, { width: 595, height: 842 }).plan; // 4 3 2 [blank] 1
  plan = appendSource(plan, 1, 2); // ... 1 E1 E2
  plan = moveItems(plan, set("1:1"), 0); // E2 4 3 2 blank 1 E1
  const out = await buildPages([rich, other], plan, { mode: "organize" });
  const r = await read(out);
  check("organize: pages in the new order", words(r) === "Extra 2 4 3 2 blank 1 Extra 1", words(r));
  check(
    "organize: sizes as shown, turned pages included",
    r.pages.map((p) => p.size).join() === "500x500,842x595,600x400,842x595,595x842,612x792,500x500",
    r.pages.map((p) => p.size)
  );
  check("organize: page 3 keeps its own turn, page 2 gets one", r.pages[2].rotate === 90 && r.pages[3].rotate === 90 && r.pages[1].rotate === 0, r.pages.map((p) => p.rotate));
  check("organize: the link to the dropped page is gone, the other follows its page", JSON.stringify(r.pages[5].links) === "[4]", r.pages[5].links);
  check("organize: bookmarks follow their pages", r.marks.join() === "Two@4,Four@2", r.marks);
  check("organize: the form keeps its values, and the added file's field is renamed", r.fields.name === "Thandi@6" && r.fields.city === "Gqeberha@3" && r.fields.name_2 === "Other file@1", r.fields);
  check("organize: the note stays on its page", r.pages[1].notes.join() === "Check this page", r.pages.map((p) => p.notes));
  check("organize: the title stays", r.title === "Field Guide");
  const lib = await PDFDocument.load(out);
  check("organize: no page left behind in the file", lib.getPageCount() === 7 && lib.context.enumerateIndirectObjects().filter(([, o]) => (o as { get?: (k: PDFName) => unknown }).get?.(PDFName.of("Type")) === PDFName.of("Page")).length === 7);
}

// --- Delete pages ----------------------------------------------------------------
{
  const { pages } = parsePageList("2, 4", 5);
  const drop = new Set(pages.map((i) => `0:${i}`));
  const kept = planFor(0, 5).filter((p) => !drop.has(p.id));
  const r = await read(await buildPages([rich], kept, { mode: "delete" }));
  check("delete: the other pages stay, in order", words(r) === "1 3 5", words(r));
  check("delete: sizes and turns stay", r.pages.map((p) => `${p.size}/${p.rotate}`).join() === "612x792/0,600x400/90,300x300/0", r.pages.map((p) => `${p.size}/${p.rotate}`));
  check("delete: links to deleted pages go, others follow", JSON.stringify(r.pages[0].links) === "[3]", r.pages[0].links);
  check("delete: bookmarks to deleted pages go", r.marks.length === 0, r.marks);
  check("delete: fields on kept pages keep their values", r.fields.name === "Thandi@1" && r.fields.city === "Gqeberha@2", r.fields);
  check("delete: every page can't go", (await failure(() => buildPages([rich], [], { mode: "delete" }))).includes("Keep at least one page"));
}

// --- Extract pages ---------------------------------------------------------------
{
  const order = parsePageList("3-4", 5).pages;
  const out = await buildPages([rich], order.map((i) => planFor(0, 5)[i]), { mode: "extract" });
  const r = await read(out);
  check("extract: one PDF with the picked pages", words(r) === "3 4", words(r));
  check("extract: sizes and turns stay", r.pages.map((p) => `${p.size}/${p.rotate}`).join() === "600x400/90,842x595/0", r.pages.map((p) => `${p.size}/${p.rotate}`));
  check("extract: only the fields of the picked pages", JSON.stringify(r.fields) === JSON.stringify({ city: "Gqeberha@1" }), r.fields);
  check("extract: the bookmark to a picked page stays", r.marks.join() === "Four@2", r.marks);
  check("extract: the note comes along", r.pages[1].notes.join() === "Check this page");
  check("extract: the title stays", r.title === "Field Guide");
  check("extract: nothing to extract is an error", (await failure(() => buildPages([rich], [], { mode: "extract" }))).includes("Pick the pages"));
  const turned = rotateItems(planFor(0, 5), set("0:0"), 90).slice(0, 1);
  check("extract: a turned or blank page is refused", (await failure(() => buildPages([rich], turned, { mode: "extract" }))).includes("Invalid page order"));
}

// --- Restricted, locked and broken files ------------------------------------------
{
  const lock = async (userPassword: string) => {
    const d = await SecurePDFDocument.load(rich);
    d.encrypt({ userPassword, ownerPassword: "owner", permissions: { printing: false, copying: false, modifying: false } });
    return d.save({ useObjectStreams: true });
  };
  const restricted = await lock("");
  const r = await read(await buildPages([restricted], [planFor(0, 5)[4], planFor(0, 5)[0]], { mode: "organize" }));
  check("an owner-password-only file opens and is rearranged", words(r) === "5 1" && r.fields.name === "Thandi@2", [words(r), r.fields]);
  const e = await read(await buildPages([restricted], [planFor(0, 5)[1]], { mode: "extract" }));
  check("an owner-password-only file can be extracted from", words(e) === "2");
  const locked = await lock("secret");
  check("a file that needs a password says to unlock it", (await failure(() => buildPages([locked], planFor(0, 5), { mode: "delete" }))).includes(ENCRYPTED_MESSAGE));
  const garbage = new TextEncoder().encode("this is not a pdf at all");
  check("a file that isn't a PDF says so", (await failure(() => buildPages([garbage], planFor(0, 1), { mode: "organize" }))).includes(UNREADABLE_MESSAGE));
  const cut = rich.slice(0, 40);
  check("a cut-off PDF says so", (await failure(() => buildPages([cut], planFor(0, 1), { mode: "extract" }))).includes(UNREADABLE_MESSAGE), await failure(() => buildPages([cut], planFor(0, 1), { mode: "extract" })));
  check(
    "a broken added file is named",
    (await failure(() => buildPages([rich, garbage], appendSource(planFor(0, 1), 1, 1), { mode: "organize", names: ["a.pdf", "bad.pdf"] }))).includes("bad.pdf"),
    await failure(() => buildPages([rich, garbage], appendSource(planFor(0, 1), 1, 1), { mode: "organize", names: ["a.pdf", "bad.pdf"] }))
  );
  // A page tree that holds itself: pdf-lib's walk overflows the stack.
  const loop = new TextEncoder().encode(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R 2 0 R] /Count 2 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
  );
  for (const mode of ["organize", "delete", "extract"] as const) {
    const said = await failure(() => buildPages([loop], planFor(0, 1), { mode }));
    check(`${mode}: a page tree that loops says the file isn't readable`, said.includes(UNREADABLE_MESSAGE), said);
  }
  check("a page that isn't in the file is refused", (await failure(() => buildPages([rich], planFor(0, 9), { mode: "organize" }))).includes("Invalid page order"));
}

// --- Long documents, cancel, and the save off this thread ---------------------------
{
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 300; i++) {
    const page = d.addPage(i % 2 ? [595, 842] : [842, 595]);
    for (let l = 0; l < 10; l++) page.drawText(`Page ${i + 1} line ${l}`, { x: 30, y: 500 - l * 14, size: 10, font });
  }
  const long = await d.save();
  let plan = reverseItems(planFor(0, 300));
  plan = removeItems(plan, new Set(plan.filter((_, i) => i % 2).map((p) => p.id)));
  const t = performance.now();
  const heard: [number, string][] = [];
  const out = await buildPages([long], plan, { mode: "organize", onProgress: (f, label) => heard.push([f, label]) });
  const ms = performance.now() - t;
  // The bar keeps moving while the pages are moved, and says when it is writing the file.
  check(
    "300 pages: progress moves on past reading the file",
    heard.some(([f, label]) => f > 0.4 && f < 0.9 && label === "Arranging pages…") && heard.at(-1)?.[1] === "Saving…" && heard.every(([f], i) => !i || f >= heard[i - 1][0]),
    heard
  );
  const doc = await PDFDocument.load(out);
  check("300 pages: reverse and drop every other one", doc.getPageCount() === 150, doc.getPageCount());
  const first = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
  const text = (await (await first.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
  check("300 pages: the last page comes first", text.startsWith("Page 300 line 0"), text.slice(0, 30));
  await first.destroy();
  check("300 pages: done in seconds", ms < 10_000, Math.round(ms));
  check("300 pages: dropped pages leave the file", out.length < long.length * 0.7, [out.length, long.length]);

  const stop = new AbortController();
  stop.abort();
  check("cancel stops the save", (await failure(() => buildPages([long], plan, { mode: "organize", signal: stop.signal }))).startsWith("AbortError"));

  const steps: string[] = [];
  const file = new File([rich.slice() as unknown as BlobPart], "guide.pdf", { type: "application/pdf" });
  const saved = await buildPagesFile([file], [planFor(0, 5)[2]], "extract", (_f, label) => steps.push(label));
  check("the save runs here when there is no worker", (await PDFDocument.load(saved)).getPageCount() === 1);
  check("progress names each step", steps.join("|") === "Reading the PDF…|Copying pages…|Saving…", steps);
  check("cancel before the save starts", (await failure(() => buildPagesFile([file], planFor(0, 5), "organize", undefined, stop.signal))).startsWith("AbortError"));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
