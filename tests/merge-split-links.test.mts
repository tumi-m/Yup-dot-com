// Merge and Split keep what makes a document work. pdf-lib's copyPages copies
// every page a link points to, whole and outside the page tree: splitting one
// page of a document with a table of contents gave back the whole file, and
// after a merge every internal link went to page 1. Both tools also built
// into an empty document, so fillable fields, named destinations (LaTeX
// links), hidden layers and the title were lost.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { randomBytes } from "node:crypto";
import { PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, type PDFPage, type PDFRef } from "pdf-lib";
import { mergeTool, splitTool, type ToolFile } from "../lib/pdf/toolkit.ts";
import { mergePdfs } from "../lib/pdf/operations.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const file = (bytes: Uint8Array, name: string) => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });
const bytesOf = async (out: ToolFile | ToolFile[]) => new Uint8Array(await (out as ToolFile).blob.arrayBuffer());

// Six pages, each with a 60 KB picture. Page 1 is a table of contents: a link
// to every page (as Word writes them), and two named-destination links (as
// LaTeX writes them). Every page links back to page 1. A form field on pages
// 1 and 2, a layer hidden by default on page 1, a title, and bookmarks.
const N = 6;
const d = await PDFDocument.create();
d.setTitle("Quarterly Report");
d.setAuthor("Nomvula Dlamini");
const font = await d.embedFont(StandardFonts.Helvetica);
const pages: PDFPage[] = [];
for (let i = 0; i < N; i++) {
  const p = d.addPage([400, 400]);
  p.drawText(`Page ${i + 1}`, { x: 40, y: 360, size: 18, font });
  const picture = PDFRawStream.of(
    d.context.obj({ Type: "XObject", Subtype: "Image", Width: 140, Height: 140, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }),
    randomBytes(140 * 140 * 3)
  );
  p.node.setXObject(PDFName.of(`Im${i}`), d.context.register(picture));
  pages.push(p);
}
const link = (on: PDFPage, y: number, target: object) =>
  on.node.addAnnot(d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [40, y, 200, y + 12], Border: [0, 0, 0], ...target })));
for (let i = 1; i < N; i++) link(pages[0], 330 - i * 16, { Dest: [pages[i].ref, "XYZ", null, null, null] });
for (let i = 1; i < N; i++) link(pages[i], 20, { A: { S: "GoTo", D: [pages[0].ref, "Fit"] } });
const named = d.context.obj({
  Names: [PDFString.of("sec.2"), d.context.obj([pages[1].ref, "Fit"]), PDFString.of("sec.5"), d.context.obj({ D: [pages[4].ref, "Fit"] })],
});
d.catalog.set(PDFName.of("Names"), d.context.obj({ Dests: d.context.register(named) }));
link(pages[0], 200, { A: { S: "GoTo", D: PDFString.of("sec.2") } });
link(pages[0], 180, { A: { S: "GoTo", D: PDFString.of("sec.5") } });
const form = d.getForm();
form.createTextField("name").addToPage(pages[0], { x: 220, y: 300, width: 120, height: 20 });
form.createCheckBox("agree").addToPage(pages[1], { x: 220, y: 300, width: 16, height: 16 });
const layer = d.context.register(d.context.obj({ Type: "OCG", Name: PDFString.of("Draft notes") }));
d.catalog.set(PDFName.of("OCProperties"), d.context.obj({ OCGs: [layer], D: { OFF: [layer], Order: [layer] } }));
pages[0].node.Resources()!.set(PDFName.of("Properties"), d.context.obj({ oc1: layer }));
// Bookmarks: Page 1, Page 4 (with Page 2 under it), Page 5.
const outlines = d.context.nextRef();
const items = [0, 3, 1, 4].map(() => d.context.nextRef());
const bookmark = (ref: PDFRef, title: string, page: number, more: object) =>
  d.context.assign(ref, d.context.obj({ Title: PDFString.of(title), Dest: [pages[page].ref, "Fit"], ...more }));
bookmark(items[0], "One", 0, { Parent: outlines, Next: items[1] });
bookmark(items[1], "Four", 3, { Parent: outlines, Prev: items[0], Next: items[3], First: items[2], Last: items[2], Count: 1 });
bookmark(items[2], "Two", 1, { Parent: items[1] });
bookmark(items[3], "Five", 4, { Parent: outlines, Prev: items[1] });
d.context.assign(outlines, d.context.obj({ Type: "Outlines", First: items[0], Last: items[3], Count: 4 }));
d.catalog.set(PDFName.of("Outlines"), outlines);
const source = await d.save();

/** What a reader makes of a document: where page `n`'s links go, fields, layers, bookmarks. */
async function read(bytes: Uint8Array, n = 1) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const targets: (number | string)[] = [];
  for (const a of await (await doc.getPage(n)).getAnnotations()) {
    if (a.subtype !== "Link") continue;
    const dest = typeof a.dest === "string" ? await doc.getDestination(a.dest) : a.dest;
    targets.push(dest ? await doc.getPageIndex(dest[0]).then((i) => i + 1, () => "nowhere") : "nowhere");
  }
  const config = await doc.getOptionalContentConfig();
  const layers = Object.values(config.getGroups() ?? {}).map((group) => (group as { visible: boolean }).visible);
  const outline = (await doc.getOutline()) ?? [];
  const titles = (list: typeof outline): string[] => list.flatMap((o) => [o.title, ...titles(o.items).map((t) => `${o.title}/${t}`)]);
  const fields = Object.keys((await doc.getFieldObjects()) ?? {}).sort();
  const info = (await doc.getMetadata()).info as { Title?: string };
  const pagesShown = doc.numPages;
  await doc.destroy();
  const lib = await PDFDocument.load(bytes);
  const pageObjects = lib.context
    .enumerateIndirectObjects()
    .filter(([, o]) => (o as { get?: (k: PDFName) => unknown }).get?.(PDFName.of("Type")) === PDFName.of("Page")).length;
  return { targets: targets.join(","), layers, bookmarks: titles(outline).join(", "), fields: fields.join(","), title: info.Title, pages: pagesShown, pageObjects };
}

const src = await read(source);
check("source: links go to their pages", src.targets === "2,3,4,5,6,2,5", src.targets);

// --- Split ------------------------------------------------------------------
const one = await bytesOf(await splitTool([file(source, "report.pdf")], { mode: "ranges", ranges: "3" }));
const oneRead = await read(one);
check("split one page: about a sixth of the file, not all of it", one.length < source.length / 3, { one: one.length, source: source.length });
check("split one page: no other pages inside", oneRead.pages === 1 && oneRead.pageObjects === 1, oneRead);
check("split one page: its link to a page left out is gone", oneRead.targets === "", oneRead.targets);

const every = (await splitTool([file(source, "report.pdf")], { mode: "every", ranges: "" })) as ToolFile[];
const everySize = every.reduce((n, f) => n + f.blob.size, 0);
check("split every page: about the size of the source together", everySize < source.length * 1.5, { everySize, source: source.length });

const firstThree = await bytesOf(await splitTool([file(source, "report.pdf")], { mode: "ranges", ranges: "1-3" }));
const three = await read(firstThree);
check("split 1-3: links to kept pages work, others are gone", three.targets === "2,3,2", three.targets);
check("split 1-3: links back to page 1 work", (await read(firstThree, 3)).targets === "1");
check("split 1-3: form fields still fill", three.fields === "agree,name", three.fields);
check("split 1-3: hidden layer stays hidden", JSON.stringify(three.layers) === "[false]", three.layers);
check("split 1-3: title kept", three.title === "Quarterly Report", three.title);
check("split 1-3: bookmarks to kept pages only", three.bookmarks === "One, Two", three.bookmarks);

// --- Merge ------------------------------------------------------------------
const merged = await bytesOf(await mergeTool([file(source, "a.pdf"), file(source, "b.pdf")]));
const first = await read(merged, 1);
const second = await read(merged, N + 1);
check("merge: no loose page copies", first.pages === 2 * N && first.pageObjects === 2 * N, first);
check("merge: first file's links go to its pages", first.targets === "2,3,4,5,6,2,5", first.targets);
check("merge: second file's links go to its own pages", second.targets === "8,9,10,11,12,8,11", second.targets);
check("merge: links back to the first page of each file", (await read(merged, N + 3)).targets === `${N + 1}`);
check("merge: both forms fill", first.fields === "agree,agree_2,name,name_2", first.fields);
check("merge: hidden layers stay hidden", JSON.stringify(first.layers) === "[false,false]", first.layers);
check("merge: title kept", first.title === "Quarterly Report", first.title);
check("merge: about twice the source", merged.length < source.length * 2.2, { merged: merged.length, source: source.length });

const edited = await mergePdfs([source, source]);
const editedSecond = await read(edited, N + 1);
check("editor merge: second file's links go to its own pages", editedSecond.targets === "8,9,10,11,12,8,11", editedSecond.targets);
check("editor merge: no loose page copies", editedSecond.pageObjects === 2 * N, editedSecond);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
