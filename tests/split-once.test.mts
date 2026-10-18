// Split read the whole file again for every part it made: "Every page
// separately" on 1000 pages took over four minutes, and twice the pages took
// four times as long. Each part is now copied out of one reading of the file,
// and comes out as the page-by-page way made it. The tool also stops when the
// person cancels or leaves.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFPage, type PDFRef } from "pdf-lib";
import { splitTool, type ToolFile } from "../lib/pdf/toolkit.ts";
import { extractFrom, extractPages } from "../lib/pdf/operations.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const file = (bytes: Uint8Array, name: string) => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });

async function textPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([612, 792]);
    for (let l = 0; l < 20; l++) p.drawText(`Page ${i + 1} line ${l} lorem ipsum dolor sit amet`, { x: 40, y: 750 - l * 18, size: 10, font });
  }
  return doc.save();
}

// --- One reading of the file for all the parts -------------------------------
let loads = 0;
const load = PDFDocument.load.bind(PDFDocument);
PDFDocument.load = ((...args: Parameters<typeof PDFDocument.load>) => {
  loads++;
  return load(...args);
}) as typeof PDFDocument.load;

const sixty = await textPdf(60);
loads = 0;
const labels: string[] = [];
const parts = (await splitTool([file(sixty, "book.pdf")], { mode: "every", ranges: "" }, { progress: (_f, label) => labels.push(label) })) as ToolFile[];
check("every page: one part per page", parts.length === 60, parts.length);
check("every page: the file is read once, not once per page", loads === 1, loads);
check("every page: progress names the part", labels[0] === "File 1 of 60" && labels.at(-1) === "File 60 of 60", [labels[0], labels.at(-1)]);
const part7 = await PDFDocument.load(await parts[6].blob.arrayBuffer());
check("every page: a part holds its own page", part7.getPageCount() === 1 && parts[6].filename === "book-page-7.pdf", parts[6].filename);

// Twice the pages takes about twice as long, not four times (400 pages took 35 s).
const big = await textPdf(400);
let t = performance.now();
await splitTool([file(big, "big.pdf")], { mode: "every", ranges: "" });
const ms = performance.now() - t;
check("every page of 400: seconds, not half a minute", ms < 10_000, Math.round(ms));

// --- Cancel ------------------------------------------------------------------
const stop = new AbortController();
let made = 0;
const cancelled = await splitTool([file(sixty, "book.pdf")], { mode: "every", ranges: "" }, {
  signal: stop.signal,
  progress: () => {
    if (++made === 3) stop.abort();
  },
}).then(
  () => "finished",
  (err) => (err as Error).name
);
check("cancel: stops with an AbortError", cancelled === "AbortError", cancelled);
check("cancel: no more parts are made", made === 3, made);

// --- Same parts as before ------------------------------------------------------
// Pages with links to each other, a named destination, bookmarks, a title and
// a form whose second widget doesn't name its page.
const d = await PDFDocument.create();
d.setTitle("Handbook");
const font = await d.embedFont(StandardFonts.Helvetica);
const pages: PDFPage[] = [];
for (let i = 0; i < 4; i++) {
  const p = d.addPage([400, 400]);
  p.drawText(`Page ${i + 1}`, { x: 40, y: 360, size: 18, font });
  pages.push(p);
}
const link = (on: PDFPage, y: number, target: object) =>
  on.node.addAnnot(d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, y, 200, y + 12], Border: [0, 0, 0], ...target })));
for (let i = 1; i < 4; i++) link(pages[0], 330 - i * 16, { Dest: [pages[i].ref, "XYZ", null, null, null] });
for (let i = 1; i < 4; i++) link(pages[i], 20, { A: { S: "GoTo", D: [pages[0].ref, "Fit"] } });
d.catalog.set(PDFName.of("Names"), d.context.obj({ Dests: d.context.register(d.context.obj({ Names: [PDFString.of("end"), d.context.obj([pages[3].ref, "Fit"])] })) }));
link(pages[0], 200, { A: { S: "GoTo", D: PDFString.of("end") } });
const form = d.getForm();
form.createTextField("name").addToPage(pages[0], { x: 220, y: 300, width: 120, height: 20 });
const agree = form.createCheckBox("agree");
agree.addToPage(pages[2], { x: 220, y: 300, width: 16, height: 16 });
agree.acroField.getWidgets()[0].dict.delete(PDFName.of("P"));
const outlines = d.context.nextRef();
const items = [0, 2, 3].map(() => d.context.nextRef());
const bookmark = (ref: PDFRef, title: string, page: number, more: object) =>
  d.context.assign(ref, d.context.obj({ Title: PDFString.of(title), Dest: [pages[page].ref, "Fit"], ...more }));
bookmark(items[0], "One", 0, { Parent: outlines, Next: items[1] });
bookmark(items[1], "Three", 2, { Parent: outlines, Prev: items[0], Next: items[2] });
bookmark(items[2], "Four", 3, { Parent: outlines, Prev: items[1] });
d.context.assign(outlines, d.context.obj({ Type: "Outlines", First: items[0], Last: items[2], Count: 3 }));
d.catalog.set(PDFName.of("Outlines"), outlines);
const source = await d.save();

/** What a reader makes of a document. */
async function read(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const targets: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    for (const a of await (await doc.getPage(n)).getAnnotations()) {
      if (a.subtype !== "Link") continue;
      const dest = typeof a.dest === "string" ? await doc.getDestination(a.dest) : a.dest;
      targets.push(`${n}>${dest ? await doc.getPageIndex(dest[0]).then((i) => i + 1, () => "nowhere") : "nowhere"}`);
    }
  }
  const outline = ((await doc.getOutline()) ?? []).map((o) => o.title).join(",");
  const fields = Object.keys((await doc.getFieldObjects()) ?? {}).sort().join(",");
  const title = ((await doc.getMetadata()).info as { Title?: string }).Title;
  const shown = doc.numPages;
  await doc.destroy();
  const objects = (await PDFDocument.load(bytes)).context.enumerateIndirectObjects().length;
  return JSON.stringify({ shown, targets, outline, fields, title, objects });
}

const src = await PDFDocument.load(source);
for (const group of [[0], [1], [2], [3], [0, 1], [0, 2, 3], [3, 0], [0, 1, 2, 3]]) {
  const before = await read(await extractPages(source, group));
  const now = await read(await extractFrom(src, group));
  check(`pages ${group.map((i) => i + 1).join("+")}: as the page-by-page split made it`, now === before, { now, before });
}
check("the source is left as it was", (await read(await src.save())) === (await read(source)));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
