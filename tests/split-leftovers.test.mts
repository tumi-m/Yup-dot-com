// Split copied the whole document catalog into every part. The tags
// (structure tree) still held every page's alt text and link addresses,
// attachments and scripts came along, and one page of a big tagged file was
// most of the file. Each part is now built from what its pages use, and a
// tagged file is still read once for all the parts.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, StandardFonts, type PDFPage, type PDFRef } from "pdf-lib";
import { splitTool, type ToolFile } from "../lib/pdf/toolkit.ts";
import { deletePages } from "../lib/pdf/operations.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const file = (bytes: Uint8Array, name = "report.pdf") => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });
const bytesOf = async (out: ToolFile | ToolFile[]) => new Uint8Array(await (out as ToolFile).blob.arrayBuffer());

/** Every object of a file as text, streams inflated, to look for what must not be there. */
async function text(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const raw = Buffer.from(obj.contents);
      try {
        out += zlib.inflateSync(raw).toString("latin1");
      } catch {
        out += raw.toString("latin1");
      }
      out += obj.dict.toString();
    } else out += obj.toString();
    out += "\n";
  }
  return out;
}

/** Page `n`'s tags as pdf.js reads them, and its links. */
async function tagsOf(bytes: Uint8Array, n: number) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(n);
  type Node = { role?: string; alt?: string; type?: string; children?: Node[] };
  const show = (node: Node): string =>
    node.role ? `${node.role}${node.alt ? `[${node.alt}]` : ""}(${(node.children ?? []).map(show).join(",")})` : (node.type ?? "?");
  const tree = show((await page.getStructTree()) as Node);
  const links = (await page.getAnnotations()).map((a: { url?: string }) => a.url ?? "").join(",");
  await doc.destroy();
  return { tree, links };
}

// Two tagged pages, as Chrome's "Save as PDF" writes them. Page 2 has a
// photo with alt text, a link and text only a screen reader reads. The file
// also has an attachment, a script, page labels and a bookmark to each page
// that points at its tag (/SE).
const d = await PDFDocument.create();
d.setTitle("Staff file");
const font = await d.embedFont(StandardFonts.Helvetica);
const ctx = d.context;
const pages = [d.addPage([400, 400]), d.addPage([400, 400])];
const draw = (page: PDFPage, content: string) => {
  page.node.setFontDictionary(PDFName.of("F1"), font.ref);
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(content)));
};
draw(pages[0], "/P <</MCID 0>> BDC BT /F1 18 Tf 40 340 Td (Public page) Tj ET EMC");
draw(pages[1], "/P <</MCID 0>> BDC BT /F1 18 Tf 40 340 Td (Staff) Tj ET EMC /Figure <</MCID 1>> BDC 0 0 1 rg 40 200 100 80 re f EMC");
const link = ctx.register(
  ctx.obj({
    Type: "Annot",
    Subtype: "Link",
    Rect: [40, 100, 200, 120],
    Border: [0, 0, 0],
    P: pages[1].ref,
    StructParent: 2,
    A: { S: "URI", URI: PDFString.of("https://secret.example.com/payroll?token=SECRET-TOKEN") },
  })
);
pages[1].node.addAnnot(link);
pages[0].node.set(PDFName.of("StructParents"), ctx.obj(0));
pages[1].node.set(PDFName.of("StructParents"), ctx.obj(1));
const [root, docEl, intro, staff, photo, linkEl] = [0, 1, 2, 3, 4, 5].map(() => ctx.nextRef());
const el = (ref: PDFRef, entries: Record<string, unknown>) => ctx.assign(ref, ctx.obj({ Type: "StructElem", P: docEl, ...entries } as never));
el(intro, { S: "P", Pg: pages[0].ref, K: 0 });
el(staff, { S: "P", Pg: pages[1].ref, K: 0, ActualText: PDFString.of("SECRET-TEXT salary band 9") });
el(photo, { S: "Figure", Pg: pages[1].ref, K: 1, Alt: PDFString.of("SECRET-ALT Photo of John Smith passport"), ID: PDFString.of("fig1") });
el(linkEl, { S: "Link", Pg: pages[1].ref, K: [{ Type: "OBJR", Obj: link }], Alt: PDFString.of("SECRET-LINK payroll") });
ctx.assign(docEl, ctx.obj({ Type: "StructElem", S: "Document", P: root, K: [intro, staff, photo, linkEl] }));
ctx.assign(
  root,
  ctx.obj({
    Type: "StructTreeRoot",
    K: [docEl],
    ParentTree: ctx.obj({ Nums: [0, [intro], 1, [staff, photo], 2, linkEl] }),
    ParentTreeNextKey: 3,
    IDTree: ctx.obj({ Names: [PDFString.of("fig1"), photo] }),
  })
);
d.catalog.set(PDFName.of("StructTreeRoot"), root);
d.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
d.catalog.set(PDFName.of("PageLabels"), ctx.obj({ Nums: [0, { S: "D" }, 1, { P: PDFString.of("SECRET-LABEL-") }] }));
const outlines = ctx.nextRef();
const [one, two] = [ctx.nextRef(), ctx.nextRef()];
ctx.assign(one, ctx.obj({ Title: PDFString.of("Intro"), Parent: outlines, Next: two, Dest: [pages[0].ref, "Fit"], SE: intro }));
ctx.assign(two, ctx.obj({ Title: PDFString.of("SECRET-BOOKMARK"), Parent: outlines, Prev: one, Dest: [pages[1].ref, "Fit"], SE: photo }));
ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: one, Last: two, Count: 2 }));
d.catalog.set(PDFName.of("Outlines"), outlines);
await d.attach(new TextEncoder().encode("name,salary\nJohn,99999\n"), "payroll.csv", { mimeType: "text/csv" });
d.addJavaScript("hello", "app.alert('SECRET-SCRIPT')");
const source = await d.save({ useObjectStreams: false });

const src = await tagsOf(source, 2);
check("source: page 2 has the photo's alt text and the link", /SECRET-ALT/.test(src.tree) && /SECRET-TOKEN/.test(src.links), src);

const secrets = ["SECRET-ALT", "SECRET-TOKEN", "secret.example.com", "SECRET-TEXT", "SECRET-LINK", "SECRET-BOOKMARK", "SECRET-LABEL", "John,99999", "payroll.csv"];
const left = (all: string) => secrets.filter((s) => all.includes(s));

// --- Split page 1 -----------------------------------------------------------
const first = await bytesOf(await splitTool([file(source)], { mode: "ranges", ranges: "1" }));
const firstText = await text(first);
check("split page 1: nothing of page 2 (alt text, link, hidden text), no attachment", left(firstText).length === 0, left(firstText));
check("split page 1: no attachments or scripts at all", !firstText.includes("EmbeddedFile") && !firstText.includes("/JavaScript"));
const firstTags = await tagsOf(first, 1);
check("split page 1: its own tags stay", firstTags.tree === "Root(Document(P(content)))", firstTags.tree);
const firstDoc = await PDFDocument.load(first);
const bookmark = firstDoc.catalog.lookup(PDFName.of("Outlines"), PDFDict).lookup(PDFName.of("First"), PDFDict);
const pointsAt = firstDoc.context.lookup(bookmark.get(PDFName.of("SE")));
check("split page 1: its bookmark still points at its tag", pointsAt instanceof PDFDict && pointsAt.get(PDFName.of("S")) === PDFName.of("P"));
check("split page 1: title kept", firstDoc.getTitle() === "Staff file", firstDoc.getTitle());

// --- Split page 2: its own alt text and link stay --------------------------
const second = await bytesOf(await splitTool([file(source)], { mode: "ranges", ranges: "2" }));
const secondTags = await tagsOf(second, 1);
check("split page 2: the photo keeps its alt text, the link its tag", /Figure\[SECRET-ALT[^\]]*\]\(content\)/.test(secondTags.tree) && /Link\[SECRET-LINK payroll\]\((annotation|object)\)/.test(secondTags.tree), secondTags.tree);
check("split page 2: the link still works", secondTags.links.includes("SECRET-TOKEN"), secondTags.links);
check("split page 2: nothing of page 1's text", !(await text(second)).includes("Public page"));

// --- Delete page 2 in the editor ---------------------------------------------
const deleted = await deletePages(source, [1]);
const deletedText = await text(deleted);
const fromPage2 = left(deletedText).filter((s) => !["John,99999", "payroll.csv"].includes(s));
check("delete page 2: nothing of it stays in the tags", fromPage2.length === 0, fromPage2);
check("delete page 2: page 1's tags stay", (await tagsOf(deleted, 1)).tree === "Root(Document(P(content)))");
check("delete page 2: the document keeps its attachment", deletedText.includes("payroll.csv"));

// --- A big tagged file: each part holds its own pages only, read once ------
const big = await PDFDocument.create();
const bigFont = await big.embedFont(StandardFonts.Helvetica);
const bc = big.context;
const bigRoot = bc.nextRef();
const bigDoc = bc.nextRef();
const kids: PDFRef[] = [];
const nums: unknown[] = [];
for (let i = 0; i < 40; i++) {
  const page = big.addPage([400, 400]);
  page.node.setFontDictionary(PDFName.of("F1"), bigFont.ref);
  const picture = bc.register(
    PDFRawStream.of(bc.obj({ Type: "XObject", Subtype: "Image", Width: 100, Height: 100, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }), randomBytes(30000))
  );
  page.node.setXObject(PDFName.of("Im1"), picture);
  page.node.set(PDFName.of("Contents"), bc.register(bc.stream(`/Figure <</MCID 0>> BDC q 100 0 0 100 40 40 cm /Im1 Do Q EMC /P <</MCID 1>> BDC BT /F1 12 Tf 40 360 Td (Page ${i + 1}) Tj ET EMC`)));
  page.node.set(PDFName.of("StructParents"), bc.obj(i));
  const figure = bc.register(bc.obj({ Type: "StructElem", S: "Figure", P: bigDoc, Pg: page.ref, K: 0, Alt: PDFString.of(`Picture ${i + 1}`) }));
  const para = bc.register(bc.obj({ Type: "StructElem", S: "P", P: bigDoc, Pg: page.ref, K: 1 }));
  kids.push(figure, para);
  nums.push(i, [figure, para]);
}
bc.assign(bigDoc, bc.obj({ Type: "StructElem", S: "Document", P: bigRoot, K: kids }));
bc.assign(bigRoot, bc.obj({ Type: "StructTreeRoot", K: [bigDoc], ParentTree: bc.obj({ Nums: nums } as never), ParentTreeNextKey: 40 }));
big.catalog.set(PDFName.of("StructTreeRoot"), bigRoot);
const bigBytes = await big.save();

const page1 = await bytesOf(await splitTool([file(bigBytes)], { mode: "ranges", ranges: "1" }));
const page1Doc = await PDFDocument.load(page1);
const elements = page1Doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of("S"))).length;
check("big file, page 1: about a fortieth of the file", page1.length < bigBytes.length / 20, { page1: page1.length, source: bigBytes.length });
check("big file, page 1: only its own tags", elements === 3, elements);
check("big file, page 1: its picture keeps its alt text", (await tagsOf(page1, 1)).tree === "Root(Document(Figure[Picture 1](content),P(content)))");

const load = PDFDocument.load;
let reads = 0;
PDFDocument.load = ((...args: Parameters<typeof load>) => {
  reads++;
  return load.apply(PDFDocument, args);
}) as typeof load;
const every = (await splitTool([file(bigBytes)], { mode: "every", ranges: "" })) as ToolFile[];
PDFDocument.load = load;
const everySize = every.reduce((n, f) => n + f.blob.size, 0);
check("big file, every page: the file is read once, not once per part", reads === 1, reads);
check("big file, every page: about the size of the source together", every.length === 40 && everySize < bigBytes.length * 1.3, { everySize, source: bigBytes.length });

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
