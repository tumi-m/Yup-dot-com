process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// Flatten PDF: fields and annotations become part of the page and the result
// looks the same in another reader (pdf.js here, as an independent reader),
// with nothing left to fill in or edit. Pages as images keep their displayed
// size and, when asked, their text. Awkward files: rotated pages, mixed
// sizes, owner-password and locked files, long documents, broken files.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { fillFormFields } from "../lib/pdf/forms.ts";
import { flattenFormsIfAny, flattenNote, flattenPdf, NothingToFlattenError } from "../lib/pdf/flatten/index.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// pdf.js prints a line for every glyph it has no font for; the checks are what matter here.
const warn = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
  warn(...args);
};

const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});

// Pages are drawn into a canvas, as in a browser.
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
  (globalThis as Record<string, unknown>).document = {
    createElement: () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }),
  };
} catch {
  canvasMod = null;
}
const { flattenTool } = await import("../lib/pdf/toolkit.ts");

const FONTS = "./node_modules/pdfjs-dist/standard_fonts/";
const pdfFile = (bytes: Uint8Array, name = "form.pdf") => new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/pdf" });
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

// ---------------------------------------------------------------------------
// Readers: pdf.js for what other apps see, pdf-lib for what's in the file.
// ---------------------------------------------------------------------------
async function open(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS, isEvalSupported: false }).promise;
}

async function annotationsOf(bytes: Uint8Array): Promise<string[][]> {
  const doc = await open(bytes);
  const out: string[][] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getAnnotations()).map((a) => a.subtype as string));
  await doc.destroy();
  return out;
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const doc = await open(bytes);
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    text += content.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
  }
  await doc.destroy();
  return text;
}

interface Picture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  /** The pixel under a point given in the page's own user space. */
  at: (x: number, y: number) => [number, number, number];
  /** Where that point is on the picture. */
  where: (x: number, y: number) => [number, number];
  /** The pixel at a place on the picture. */
  pixel: (u: number, v: number) => [number, number, number];
}

/** pdf.js's picture of a page, annotations and fields included, as readers show it. */
async function render(bytes: Uint8Array, pageNo = 1, scale = 1): Promise<Picture> {
  const doc = await open(bytes);
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const canvas = canvasMod!.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  await doc.destroy();
  return {
    width: canvas.width,
    height: canvas.height,
    data,
    where: (x, y) => vp.convertToViewportPoint(x, y).map(Math.floor) as [number, number],
    pixel(u, v) {
      const k = (v * canvas.width + u) * 4;
      return [data[k], data[k + 1], data[k + 2]];
    },
    at(x, y) {
      return this.pixel(...this.where(x, y));
    },
  };
}

/** Share of pixels that differ visibly between two pictures of the same size. */
function difference(a: Picture, b: Picture, tolerance = 48): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let off = 0;
  for (let k = 0; k < a.data.length; k += 4) {
    if (Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]), Math.abs(a.data[k + 2] - b.data[k + 2])) > tolerance) off++;
  }
  return off / (a.data.length / 4);
}

/** How many pixels look like `colour` (each channel within 60). */
function count(p: Picture, colour: [number, number, number]): number {
  let n = 0;
  for (let k = 0; k < p.data.length; k += 4) {
    if (Math.abs(p.data[k] - colour[0]) < 60 && Math.abs(p.data[k + 1] - colour[1]) < 60 && Math.abs(p.data[k + 2] - colour[2]) < 60) n++;
  }
  return n;
}

const near = (px: [number, number, number], colour: [number, number, number]) => px.every((c, i) => Math.abs(c - colour[i]) < 60);
const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 160, 0];
const MAGENTA: [number, number, number] = [255, 0, 255];
const WHITE: [number, number, number] = [255, 255, 255];

/** Every dictionary in the file whose /Subtype is one of `kinds`, linked to or not. */
async function objectsOfKind(bytes: Uint8Array, kinds: string[]): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : null;
    const sub = dict?.lookup(PDFName.of("Subtype"));
    if (sub instanceof PDFName && kinds.includes(sub.decodeText())) n++;
  }
  return n;
}

/** Every object in the file as text, streams inflated, whether anything points at it or not. */
async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    out += obj.toString();
    if (obj instanceof PDFRawStream) {
      try {
        out += Buffer.from(inflateSync(obj.contents)).toString("latin1");
      } catch {
        out += Buffer.from(obj.contents).toString("latin1");
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A filled-in form: text, checkbox, dropdown and a radio group, over some page text. */
async function formPdf(values: Record<string, string> = { full_name: "Ada Lovelace", agree: "true", plan: "Pro", size: "Large" }) {
  const base = await PDFDocument.create();
  const font = await base.embedFont(StandardFonts.Helvetica);
  base.addPage([595, 842]).drawText("Application form", { x: 60, y: 780, size: 18, font });
  const withForm = await bakeAnnotations(await base.save(), [
    { id: "a", page: 0, type: "field", field: "text", name: "full_name", value: "", options: [], fontSize: 12, x: 60, y: 100, width: 220, height: 24 },
    { id: "b", page: 0, type: "field", field: "checkbox", name: "agree", value: "", options: [], fontSize: 12, x: 60, y: 150, width: 18, height: 18 },
    { id: "c", page: 0, type: "field", field: "dropdown", name: "plan", value: "Free", options: ["Free", "Pro", "Team"], fontSize: 12, x: 60, y: 200, width: 140, height: 24 },
    { id: "d", page: 0, type: "field", field: "radio", name: "size", value: "Small", options: [], fontSize: 12, x: 60, y: 250, width: 16, height: 16 },
    { id: "e", page: 0, type: "field", field: "radio", name: "size", value: "Large", options: [], fontSize: 12, x: 100, y: 250, width: 16, height: 16 },
  ] as Annotation[]);
  return fillFormFields(withForm, values);
}

/** A form XObject appearance: `ops` drawn in a box. */
function appearance(doc: PDFDocument, ops: string, bbox: number[], matrix?: number[]) {
  return doc.context.register(
    doc.context.stream(ops, { Type: "XObject", Subtype: "Form", BBox: bbox, ...(matrix ? { Matrix: matrix } : {}) })
  );
}

function addAnnot(doc: PDFDocument, pageIndex: number, dict: Record<string, unknown>) {
  const page = doc.getPage(pageIndex);
  const ref = doc.context.register(doc.context.obj(dict as never));
  const annots = page.node.Annots();
  if (annots) annots.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  return ref;
}

/**
 * Comments of every kind: appearances in a plain box, an offset box and a
 * turned one; a highlight and ink with no appearance (left to the reader); a
 * hidden one; a note with its pop-up and no picture; and a link.
 */
async function annotatedPdf(rotate = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Page text stays", { x: 60, y: 780, size: 18, font });
  page.drawText("Highlighted words", { x: 60, y: 600, size: 18, font });
  if (rotate) page.setRotation(degrees(rotate));
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Square", Rect: [100, 400, 160, 440], F: 4, AP: { N: appearance(doc, "1 0 0 rg 0 0 60 40 re f", [0, 0, 60, 40]) } });
  // The appearance's box starts at 10,10: it must still fill the Rect.
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Square", Rect: [200, 400, 260, 440], F: 4, AP: { N: appearance(doc, "0 0 1 rg 10 10 60 40 re f", [10, 10, 70, 50]) } });
  // Drawn upright then turned a quarter by its Matrix: 40 wide, 60 high becomes 60 by 40.
  addAnnot(doc, 0, {
    Type: "Annot", Subtype: "Stamp", Rect: [300, 400, 360, 440], F: 4,
    AP: { N: appearance(doc, "0 0.63 0 rg 0 0 40 60 re f", [0, 0, 40, 60], [0, 1, -1, 0, 0, 0]) },
  });
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Square", Rect: [400, 400, 460, 440], F: 6, AP: { N: appearance(doc, "1 0 1 rg 0 0 60 40 re f", [0, 0, 60, 40]) } });
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Highlight", Rect: [58, 594, 220, 618], F: 4, C: [1, 1, 0], QuadPoints: [58, 618, 220, 618, 58, 594, 220, 594] });
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Ink", Rect: [100, 200, 300, 260], F: 4, C: [0, 0, 1], BS: { W: 3 }, InkList: [[110, 210, 200, 250, 290, 210]] });
  const popup = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Popup", Rect: [300, 700, 500, 800] }));
  const note = addAnnot(doc, 0, { Type: "Annot", Subtype: "Text", Rect: [500, 780, 520, 800], Contents: "A private remark", Popup: popup });
  (doc.context.lookup(popup) as PDFDict).set(PDFName.of("Parent"), note);
  (page.node.Annots() as PDFArray).push(popup);
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Link", Rect: [60, 770, 200, 800], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/") } });
  return doc.save();
}

// ---------------------------------------------------------------------------
// Form fields only
// ---------------------------------------------------------------------------
const form = await formPdf();
{
  const { bytes, report } = await flattenPdf(form, "forms");
  const doc = await PDFDocument.load(bytes);
  check("forms: no form is left in the file", !doc.catalog.get(PDFName.of("AcroForm")) && doc.getForm().getFields().length === 0);
  check("forms: readers find no fields to fill", (await annotationsOf(bytes)).flat().length === 0, await annotationsOf(bytes));
  check("forms: counts fields, not radio buttons", report.fields === 4 && report.keptFields === 0, report);
  check("forms: no copy of the old fields stays in the file", (await objectsOfKind(bytes, ["Widget"])) === 0);
  const text = await textOf(bytes);
  check("forms: the typed and picked values are page text now", /Ada Lovelace/.test(text) && /\bPro\b/.test(text) && /Application form/.test(text), text);
  if (canvasMod) {
    const before = await render(form);
    const after = await render(bytes);
    check("forms: the page looks the same in another reader", difference(before, after) < 0.003, difference(before, after));
    check("forms: the tick is still there", !near(after.at(69, 842 - 159), WHITE) && near(before.at(69, 842 - 159), after.at(69, 842 - 159)));
  }
}
{
  // A field typed in a script Helvetica lacks stays fillable rather than showing nothing.
  const greek = await formPdf({ full_name: "Ολυμπία", agree: "true", plan: "Team", size: "Small" });
  const { bytes, report } = await flattenPdf(greek, "forms");
  const fields = (await PDFDocument.load(bytes)).getForm().getFields().map((f) => f.getName());
  check("forms: a value the font can't draw stays a field", fields.length === 1 && fields[0] === "full_name", fields);
  check("forms: the others are flattened", report.fields === 3 && report.keptFields === 1, report);
  check("forms: the result says which stayed", /1 field left fillable/.test(flattenNote(report) ?? ""), flattenNote(report));
  check("forms: what stays is drawn by the reader", (await PDFDocument.load(bytes)).getForm().acroForm.dict.get(PDFName.of("NeedAppearances"))?.toString() === "true");
}
{
  // XFA forms carry a second copy that XFA readers show instead.
  const doc = await PDFDocument.load(form);
  doc.getForm().acroForm.dict.set(PDFName.of("XFA"), doc.context.register(doc.context.stream("<xdp:xdp/>")));
  const { bytes } = await flattenPdf(await doc.save(), "forms");
  check("forms: the XFA copy goes with the form", !(await PDFDocument.load(bytes)).catalog.get(PDFName.of("AcroForm")));
}
{
  // What was flattened away must not stay in the file where nothing points at
  // it: a comment's attached file, the XFA form data, a field's old picture
  // and the field's value itself (it is only paint on the page now), also
  // when another field is kept fillable.
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const f = doc.getForm();
  const stale = f.createTextField("stale");
  stale.setText("OLDVALUE");
  stale.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  stale.acroField.dict.set(PDFName.of("V"), PDFString.of("NEWVALUE"));
  f.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  const file = ctx.register(ctx.flateStream("ATTACHSECRET", { Type: "EmbeddedFile" }));
  const spec = ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("a.txt"), EF: { F: file } }));
  addAnnot(doc, 0, { Type: "Annot", Subtype: "FileAttachment", Rect: [300, 700, 320, 720], FS: spec, AP: { N: appearance(doc, "0 0 1 rg 0 0 20 20 re f", [0, 0, 20, 20]) } });
  const datasets = ctx.register(ctx.stream("<xfa:datasets><name>XFASECRET</name></xfa:datasets>"));
  f.acroForm.dict.set(PDFName.of("XFA"), ctx.obj([PDFString.of("datasets"), datasets]));
  const withAll = await doc.save({ updateFieldAppearances: false });

  const kept = await PDFDocument.load(withAll);
  const greek = kept.getForm().createTextField("greek");
  greek.addToPage(kept.getPage(0), { x: 50, y: 600, width: 200, height: 24 });
  greek.acroField.dict.set(PDFName.of("V"), PDFHexString.fromText("Καλημέρα"));
  const withKept = await kept.save({ updateFieldAppearances: false });

  for (const [label, input, scope] of [
    ["fields and comments", withAll, "annotations"],
    ["fields only", withAll, "forms"],
    ["one field kept fillable", withKept, "annotations"],
  ] as const) {
    const { bytes } = await flattenPdf(input, scope);
    const all = await everything(bytes);
    // Appearances write text as hex strings, so look for both spellings.
    const hex = all.toUpperCase();
    const found = (m: string) => all.includes(m) || hex.includes(Buffer.from(m).toString("hex").toUpperCase());
    const gone = ["OLDVALUE", "(NEWVALUE)", "XFASECRET", ...(scope === "annotations" ? ["ATTACHSECRET"] : [])].filter(found);
    check(`${label}: nothing removed stays hidden in the file`, gone.length === 0, gone);
    check(`${label}: the current value is what shows`, /NEWVALUE/.test(await textOf(bytes)));
  }
}
{
  const annotated = await annotatedPdf();
  const r = await settle(flattenPdf(annotated, "forms"));
  check(
    "forms: a file with only comments says how to flatten them",
    r.error instanceof NothingToFlattenError && /choose Fields and comments/.test(r.error.message),
    r.error?.message
  );
  const plain = await (async () => {
    const d = await PDFDocument.create();
    d.addPage();
    return d.save();
  })();
  const p = await settle(flattenPdf(plain, "annotations"));
  check("a file with nothing to flatten says so", p.error instanceof NothingToFlattenError && /no form fields or comments/.test(p.error.message) && /choose Pages as images\./.test(p.error.message), p.error?.message);
}

// ---------------------------------------------------------------------------
// Fields and annotations
// ---------------------------------------------------------------------------
for (const rotate of [0, 90]) {
  const label = rotate ? "rotated page" : "annotations";
  const annotated = await annotatedPdf(rotate);
  const { bytes, report } = await flattenPdf(annotated, "annotations");
  const left = (await annotationsOf(bytes))[0];
  check(`${label}: only the link is left, and it still works`, left.length === 1 && left[0] === "Link", left);
  check(`${label}: counts what was flattened`, report.annotations === 7 && report.blank === 1, report);
  check(`${label}: the note and its pop-up are gone from the file`, (await objectsOfKind(bytes, ["Text", "Popup", "Square", "Ink", "Highlight", "Stamp"])) === 0);
  check(`${label}: page text is still text`, /Page text stays/.test(await textOf(bytes)));
  check(`${label}: the page keeps its turn`, (await PDFDocument.load(bytes)).getPage(0).getRotation().angle === rotate);
  if (canvasMod) {
    const before = await render(annotated);
    const after = await render(bytes);
    check(`${label}: looks the same in another reader`, difference(before, after) < 0.003, difference(before, after));
    check(`${label}: a plain appearance fills its box`, near(after.at(130, 420), RED));
    check(`${label}: an offset appearance box lands on its Rect`, near(after.at(205, 405), BLUE) && near(after.at(255, 435), BLUE), [after.at(205, 405), after.at(255, 435)]);
    check(`${label}: a turned appearance is turned`, near(after.at(305, 405), GREEN) && near(after.at(355, 435), GREEN), [after.at(305, 405), after.at(355, 435)]);
    check(`${label}: a hidden one stays hidden`, count(after, MAGENTA) === 0);
    check(`${label}: a highlight with no picture is drawn as readers draw it`, near(after.at(62, 597), [255, 255, 0]), after.at(62, 597));
    check(`${label}: ink with no picture is drawn`, count(after, BLUE) > count(before, BLUE) * 0.8 && count(before, BLUE) > 0);
  }
}
{
  // Forms and annotations together, and a field the form tree doesn't know about.
  const doc = await PDFDocument.load(await formPdf());
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Square", Rect: [300, 100, 360, 140], F: 4, AP: { N: appearance(doc, "1 0 0 rg 0 0 60 40 re f", [0, 0, 60, 40]) } });
  addAnnot(doc, 0, { Type: "Annot", Subtype: "Widget", FT: "Tx", T: "stray", Rect: [300, 300, 400, 320], F: 4, AP: { N: appearance(doc, "0 0 1 rg 0 0 100 20 re f", [0, 0, 100, 20]) } });
  const input = await doc.save();
  const { bytes, report } = await flattenPdf(input, "annotations");
  check("both: nothing left to fill or edit", (await annotationsOf(bytes)).flat().length === 0, await annotationsOf(bytes));
  check("both: fields and the comment counted", report.fields === 4 && report.annotations === 1, report);
  if (canvasMod) {
    const after = await render(bytes);
    check("both: a widget outside the form is painted too", near(after.at(350, 310), BLUE));
    check("both: looks the same", difference(await render(input), after) < 0.003);
  }
}

// ---------------------------------------------------------------------------
// Awkward files
// ---------------------------------------------------------------------------
{
  // Mixed page sizes, one turned, each with a field.
  const base = await PDFDocument.create();
  base.addPage([595, 842]);
  base.addPage([792, 612]);
  base.addPage([200, 200]).setRotation(degrees(270));
  const mixed = await bakeAnnotations(
    await base.save(),
    [0, 1, 2].map((page) => ({ id: `f${page}`, page, type: "field", field: "text", name: `f${page}`, value: `Value ${page + 1}`, options: [], fontSize: 12, x: 20, y: 20, width: 150, height: 22 })) as Annotation[]
  );
  const { bytes } = await flattenPdf(mixed, "forms");
  const doc = await PDFDocument.load(bytes);
  const sizes = doc.getPages().map((p) => `${p.getWidth()}x${p.getHeight()}@${p.getRotation().angle}`);
  check("mixed sizes: every page keeps its size and turn", sizes.join(" ") === "595x842@0 792x612@0 200x200@270", sizes);
  check("mixed sizes: each value is on its own page", (await textOf(bytes)).split("\n").slice(0, 3).every((t, i) => t.includes(`Value ${i + 1}`)), await textOf(bytes));
  if (canvasMod) {
    for (let i = 1; i <= 3; i++) check(`mixed sizes: page ${i} looks the same`, difference(await render(mixed, i), await render(bytes, i)) < 0.003);
  }
}
{
  // Restricted by an owner password only: it opens without one, so it flattens.
  const d = await SecurePDFDocument.load(form);
  d.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false, copying: false, modifying: false } });
  const restricted = await d.save({ useObjectStreams: false });
  const r = await settle(flattenPdf(restricted, "forms"));
  const out = r.value ? await PDFDocument.load(r.value.bytes) : null;
  check("owner password only: flattened", !!out && out.getForm().getFields().length === 0, r.error?.message);
  check("owner password only: the values survive decryption", !!r.value && /Ada Lovelace/.test(await textOf(r.value.bytes)));

  const l = await SecurePDFDocument.load(form);
  l.encrypt({ userPassword: "open sesame", ownerPassword: "owner" });
  const locked = await l.save({ useObjectStreams: false });
  for (const mode of ["forms", "annotations", "images"]) {
    const t = await settle(flattenTool([pdfFile(locked)], { mode, dpi: "150", text: "" }));
    check(`locked file (${mode}): asks to unlock it first`, /password-protected\. Unlock it first/.test(t.error?.message ?? ""), t.error?.message);
  }
}
{
  const broken = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");
  for (const mode of ["forms", "annotations", "images"]) {
    const t = await settle(flattenTool([pdfFile(broken)], { mode, dpi: "150", text: "" }));
    check(`broken file (${mode}): a plain message`, t.error?.message === "This file isn't a readable PDF.", t.error?.message);
  }
  const junk = await settle(flattenTool([pdfFile(new Uint8Array([1, 2, 3]))], { mode: "annotations", dpi: "150", text: "" }));
  check("not a PDF at all: a plain message", junk.error?.message === "This file isn't a readable PDF.", junk.error?.message);
}
{
  // A long form: 300 pages, a field each.
  const base = await PDFDocument.create();
  for (let i = 0; i < 300; i++) base.addPage([595, 842]);
  const long = await bakeAnnotations(
    await base.save(),
    Array.from({ length: 300 }, (_, page) => ({ id: `l${page}`, page, type: "field", field: "text", name: `line${page}`, value: `Line ${page}`, options: [], fontSize: 12, x: 40, y: 40, width: 200, height: 22 })) as Annotation[]
  );
  const steps: string[] = [];
  const started = performance.now();
  const { bytes, report } = await flattenPdf(long, "forms", { onProgress: (_f, label) => steps.push(label) });
  const seconds = (performance.now() - started) / 1000;
  const out = await PDFDocument.load(bytes);
  check("300 pages: every field flattened", report.fields === 300 && out.getPageCount() === 300 && out.getForm().getFields().length === 0, report);
  check("300 pages: says how far it is", steps.includes("Page 101 of 300") && steps.at(-1) === "Saving…", steps.slice(0, 3));
  check("300 pages: quick", seconds < 15, seconds.toFixed(1));
  const ctl = new AbortController();
  ctl.abort();
  const stopped = await settle(flattenPdf(long, "forms", { signal: ctl.signal }));
  check("cancel stops it", stopped.error?.name === "AbortError", stopped.error?.name);
}

// ---------------------------------------------------------------------------
// Through the tool, and the editor's save
// ---------------------------------------------------------------------------
{
  const t = await flattenTool([pdfFile(form, "application.pdf")], { mode: "annotations", dpi: "150", text: "" });
  check("tool: names the result", t.filename === "application-flattened.pdf", t.filename);
  check("tool: no note when everything was flattened", t.note === undefined, t.note);
  const r = await settle(flattenTool([pdfFile(await annotatedPdf())], { mode: "forms", dpi: "150", text: "" }));
  check("tool: nothing to flatten is a message, not a crash", /no form fields/.test(r.error?.message ?? ""), r.error?.message);

  const saved = await flattenFormsIfAny(form);
  check("editor save: the form is flattened", (await PDFDocument.load(saved.bytes)).getForm().getFields().length === 0);
  check("editor save: no note when every field was flattened", saved.note === undefined, saved.note);
  const kept = await flattenFormsIfAny(await formPdf({ full_name: "Ολυμπία", agree: "true", plan: "Team", size: "Small" }));
  check("editor save: says which fields stayed fillable", /1 field left fillable/.test(kept.note ?? ""), kept.note);
  const plainDoc = await PDFDocument.create();
  plainDoc.addPage();
  const plain = await plainDoc.save();
  const same = await flattenFormsIfAny(plain);
  check("editor save: a file with no form comes back as it was", same.bytes === plain && same.note === undefined);
}

// ---------------------------------------------------------------------------
// Everything as images
// ---------------------------------------------------------------------------
if (!canvasMod) {
  check("pages as images need node-canvas (an optional dependency of pdfjs-dist)", false);
} else {
  const annotated = await annotatedPdf(90);
  const t = await flattenTool([pdfFile(annotated, "turned.pdf")], { mode: "images", dpi: "150", text: "" });
  const bytes = await bytesOf(t.blob);
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  check("images: one page, upright at its displayed size", doc.getPageCount() === 1 && page.getWidth() === 842 && page.getHeight() === 595 && page.getRotation().angle === 0, [page.getWidth(), page.getHeight(), page.getRotation().angle]);
  check("images: nothing left to select, fill or click", (await textOf(bytes)).trim() === "" && (await annotationsOf(bytes)).flat().length === 0);
  const images = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
  const width = Number((images[0]?.[1] as PDFStream | undefined)?.dict.get(PDFName.of("Width"))?.toString());
  check("images: one picture per page, at the chosen DPI", images.length === 1 && Math.abs(width - (842 * 150) / 72) <= 2, [images.length, width]);
  const before = await render(annotated);
  const after = await render(bytes);
  check("images: looks the same, comments included", difference(before, after, 72) < 0.02 && near(after.pixel(...before.where(130, 420)), RED), difference(before, after, 72));
  check("images: hidden comments stay hidden", count(after, MAGENTA) === 0);

  const hi = await flattenTool([pdfFile(annotated)], { mode: "images", dpi: "300", text: "" });
  const lo = await flattenTool([pdfFile(annotated)], { mode: "images", dpi: "100", text: "" });
  check("images: more DPI, more detail", hi.blob.size > lo.blob.size, [hi.blob.size, lo.blob.size]);

  const kept = await flattenTool([pdfFile(form)], { mode: "images", dpi: "150", text: "true" });
  const keptBytes = await bytesOf(kept.blob);
  const keptText = await textOf(keptBytes);
  check("images + text: still searchable, field values too", /Application form/.test(keptText) && /Ada Lovelace/.test(keptText), keptText);
  check("images + text: the text is invisible", near((await render(keptBytes)).at(400, 780), WHITE));
  check("images + text: no fields left", (await annotationsOf(keptBytes)).flat().length === 0);

  // Mixed sizes and many pages, cancelled part way.
  const base = await PDFDocument.create();
  for (let i = 0; i < 12; i++) base.addPage(i % 2 ? [792, 612] : [300, 500]).drawRectangle({ x: 10, y: 10, width: 50, height: 50, color: rgb(0, 0, 1) });
  const many = await base.save();
  const out = await PDFDocument.load(await bytesOf((await flattenTool([pdfFile(many)], { mode: "images", dpi: "100", text: "" })).blob));
  check("images: mixed sizes kept page by page", out.getPages().every((p, i) => (i % 2 ? p.getWidth() === 792 && p.getHeight() === 612 : p.getWidth() === 300 && p.getHeight() === 500)));
  const ctl = new AbortController();
  const labels: string[] = [];
  const run = settle(
    flattenTool([pdfFile(many)], { mode: "images", dpi: "100", text: "" }, {
      signal: ctl.signal,
      progress: (_f, label) => {
        labels.push(label);
        if (label === "Page 3 of 12") ctl.abort();
      },
    })
  );
  const r = await run;
  check("images: cancel stops between pages", r.error?.name === "AbortError" && !labels.includes("Page 5 of 12"), [r.error?.name, labels]);

  // Too many pictures to hold at once: refused before any page is drawn, with a resolution that fits.
  const big = await PDFDocument.create();
  for (let i = 0; i < 200; i++) big.addPage([595, 842]);
  const bigBytes = await big.save();
  const drawn: string[] = [];
  const tooBig = await settle(flattenTool([pdfFile(bigBytes)], { mode: "images", dpi: "300", text: "" }, { progress: (_f, label) => drawn.push(label) }));
  check("images: too many pixels is refused, pointing at a lower resolution", /Pick 200 DPI or less\./.test(tooBig.error?.message ?? ""), tooBig.error?.message);
  check("images: refused before drawing anything", drawn.length === 0, drawn);
  const { tooBigToPicture } = await import("../lib/pdf/toolkit.ts");
  check("images: when no resolution fits, says to split", /Split the PDF first/.test(tooBigToPicture(20_000 * 1e6, 100, 1e9)));
  const zero = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  const none = await settle(flattenTool([pdfFile(zero)], { mode: "images", dpi: "150", text: "" }));
  check("images: a PDF with no pages says so, and makes no blank page", none.error?.message === "This PDF has no pages.", none.error?.message);

  // Owner password only: pdf.js opens it without one.
  const d = await SecurePDFDocument.load(form);
  d.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false, copying: false, modifying: false } });
  const restricted = await d.save({ useObjectStreams: false });
  const ro = await settle(flattenTool([pdfFile(restricted)], { mode: "images", dpi: "100", text: "" }));
  check("images: an owner-password file flattens", !!ro.value && (await PDFDocument.load(await bytesOf(ro.value.blob))).getPageCount() === 1, ro.error?.message);
}

// ---------------------------------------------------------------------------
// Listed where tools are
// ---------------------------------------------------------------------------
{
  const { getTool, TOOLS } = await import("../lib/tools.tsx");
  const { PROCESSORS } = await import("../components/tools/processors.ts");
  const { panelSpec } = await import("../components/tools/panel-spec.tsx");
  const { filterTools } = await import("../components/tool-filter.ts");
  const sitemapModule = await import("../app/sitemap.ts");
  // The app files are CommonJS to tsx here, so the default export may arrive wrapped.
  let sitemap: unknown = sitemapModule.default;
  while (typeof sitemap !== "function") sitemap = (sitemap as { default: unknown }).default;
  const urls = (sitemap as () => { url: string }[])().map((e) => e.url);
  check("in the sitemap", urls.some((u) => u.endsWith("/tools/flatten-pdf")));
  const tool = getTool("flatten-pdf");
  check("registered once, under Edit & Sign", !!tool && tool.category === "edit" && TOOLS.filter((t) => t.slug === "flatten-pdf").length === 1);
  check("a workbench tool with a processor that can be cancelled", !!tool && panelSpec(tool).kind === "workbench" && !!PROCESSORS["flatten-pdf"]?.cancellable);
  check("search finds it by what people type", ["flatten", "fillable", "annotations", "lock form"].every((q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "flatten-pdf")));
  const fields = PROCESSORS["flatten-pdf"].fields;
  const mode = fields.find((f) => f.key === "mode")!;
  check("fields and comments is the default", mode.default === "annotations");
  check("each choice says its trade-off in one sentence", mode.options!.every((o) => !!o.hint && o.hint.split(/[.!?](\s|$)/).filter((x) => x?.trim()).length === 1));
  check("DPI and searchable text only for images", fields.filter((f) => f.showIf?.value === "images").map((f) => f.key).join() === "dpi,text");
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
