process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// Repair PDF: files broken the ways real files break (cut off part way, junk
// in front or behind, a wrong or missing index, a damaged object stream, no
// /Root, a page tree that loops, missing or damaged page content) come back
// as files pdf-lib and pdf.js both open, with the pages and text expected,
// and a report that says what was lost. Files with nothing left to recover,
// and files that need a password, are refused with a plain message, never an
// empty PDF.
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFDict, PDFString, StandardFonts, degrees, rgb } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// pdf.js and pdf-lib print a line for every damaged object they step over; the checks are what matter here.
const log = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && /^Warning:/.test(args[0])) return;
  log(...args);
};
console.warn = () => {};

const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});

// Pages that become pictures are drawn into a canvas, as in a browser.
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
  (globalThis as Record<string, unknown>).document = {
    createElement: () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }),
  };
} catch {
  canvasMod = null;
}

const { repairPdf, repairLines, pageList, NEEDS_UNLOCK } = await import("../lib/pdf/repair/index.ts");
const { salvage } = await import("../lib/pdf/repair/salvage.ts");
const { inflateUpToDamage } = await import("../lib/pdf/repair/rebuild.ts");

const FONTS = "./node_modules/pdfjs-dist/standard_fonts/";
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
// Byte for byte: TextDecoder's "latin1" is windows-1252, which changes 0x80-0x9f.
const asText = (b: Uint8Array) => {
  let out = "";
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return out;
};
const join = (...parts: (Uint8Array | string)[]) => {
  const list = parts.map((p) => (typeof p === "string" ? latin1(p) : p));
  const out = new Uint8Array(list.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of list) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
const repair = (bytes: Uint8Array, opts = {}) => repairPdf(blob(bytes), opts);

// ---------------------------------------------------------------------------
// Readers: the repaired file must open in both, strictly in pdf-lib.
// ---------------------------------------------------------------------------
interface Read {
  pages: number;
  text: string[];
  sizes: [number, number][];
}

async function readBoth(bytes: Uint8Array): Promise<Read & { lib: number }> {
  const lib = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS, isEvalSupported: false, stopAtErrors: true }).promise;
  const text: string[] = [];
  const sizes: [number, number][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push([Math.round(vp.width), Math.round(vp.height)]);
    const content = await page.getTextContent();
    text.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim());
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { pages, text, sizes, lib: lib.getPageCount() };
}

/** Repairs `bytes` and reads the result back in pdf-lib and pdf.js. */
async function repaired(bytes: Uint8Array) {
  const { bytes: out, report } = await repair(bytes);
  const read = await readBoth(out);
  return { out, report, read, lines: repairLines(report).map((l) => l.text) };
}

// ---------------------------------------------------------------------------
// A plain PDF writer, so each object sits where the test wants it and the
// damage lands exactly where it should.
// ---------------------------------------------------------------------------
interface Obj {
  num: number;
  /** The dictionary (or any object) as written. */
  body: string;
  /** Stream data, written after the dictionary with its /Length. */
  stream?: Uint8Array;
}

function writePdf(objects: Obj[], trailer = "/Root 1 0 R"): Uint8Array {
  const parts: Uint8Array[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let at = parts[0].length;
  const offsets = new Map<number, number>();
  for (const o of objects) {
    offsets.set(o.num, at);
    const head = o.stream ? `${o.num} 0 obj\n${o.body.replace(/>>\s*$/, ` /Length ${o.stream.length} >>`)}\nstream\n` : `${o.num} 0 obj\n${o.body}\nendobj\n`;
    const piece = o.stream ? join(head, o.stream, "\nendstream\nendobj\n") : latin1(head);
    parts.push(piece);
    at += piece.length;
  }
  const size = Math.max(...objects.map((o) => o.num)) + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    const off = offsets.get(n);
    xref += off === undefined ? "0000000000 65535 f \n" : `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(latin1(`${xref}trailer\n<< /Size ${size} ${trailer} >>\nstartxref\n${at}\n%%EOF\n`));
  return join(...parts);
}

const pageText = (n: number) => `Page ${n} marker`;
const content = (n: number, extra = "") => latin1(`BT /F1 24 Tf 72 700 Td (${pageText(n)}) Tj ET\n${extra}`);

interface Layout {
  pages: number;
  /** Content streams compressed. */
  flate?: boolean;
  /** Extra objects, and changes to the page dictionaries. */
  pageExtra?: (n: number) => string;
  extra?: Obj[];
  /** Objects 3+: font 3, then per page a page dict and its content. */
  contentExtra?: (n: number) => string;
  rotate?: (n: number) => number;
  size?: (n: number) => [number, number];
}

/** Catalog 1, page tree 2, font 3, then each page's dictionary and its content, page by page. */
function layoutObjects(l: Layout): Obj[] {
  const objs: Obj[] = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: `<< /Type /Pages /Kids [${Array.from({ length: l.pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${l.pages} >>` },
    { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
  ];
  for (let i = 0; i < l.pages; i++) {
    const n = i + 1;
    const [w, h] = l.size?.(n) ?? [612, 792];
    const rot = l.rotate?.(n);
    objs.push({
      num: 4 + i * 2,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${rot ? ` /Rotate ${rot}` : ""} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R${l.pageExtra?.(n) ?? ""} >>`,
    });
    const data = content(n, l.contentExtra?.(n));
    objs.push({ num: 5 + i * 2, body: l.flate ? "<< /Filter /FlateDecode >>" : "<< >>", stream: l.flate ? new Uint8Array(deflateSync(data)) : data });
  }
  return [...objs, ...(l.extra ?? [])];
}

const markers = (n: number) => Array.from({ length: n }, (_, i) => pageText(i + 1));
const sameText = (read: Read, expected: string[]) => read.text.length === expected.length && read.text.every((t, i) => t.includes(expected[i]));

// ---------------------------------------------------------------------------
// A healthy file: no damage found, nothing lost, and the copy is the same.
// ---------------------------------------------------------------------------
const plain = writePdf(layoutObjects({ pages: 4 }));
{
  const r = await repaired(plain);
  check("healthy: opens in pdf-lib and pdf.js with all 4 pages", r.read.pages === 4 && r.read.lib === 4, r.read);
  check("healthy: the text is as it was", sameText(r.read, markers(4)), r.read.text);
  check("healthy: the report says no damage was found", r.lines.length === 1 && /^No damage found: all 4 pages are as they were\.$/.test(r.lines[0]), r.lines);
  check("healthy: no page became a picture", r.report.pictures.length === 0 && r.report.lost.length === 0);
}


/** The same bytes with `find` replaced, byte for byte (latin1 keeps binary data as it is). */
const edit = (bytes: Uint8Array, find: string | RegExp, replace: string | ((...m: string[]) => string)) =>
  latin1(asText(bytes).replace(find as RegExp, replace as string));
const offsetOf = (bytes: Uint8Array, find: string) => asText(bytes).indexOf(find);

// ---------------------------------------------------------------------------
// Around the file: junk in front (a saved web page, an email header), junk
// after the end, a wrong or missing index.
// ---------------------------------------------------------------------------
{
  const prefixed = join("HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\n\r\n".repeat(30), plain);
  const r = await repaired(prefixed);
  check("junk in front: all 4 pages, text kept", r.read.pages === 4 && sameText(r.read, markers(4)), r.read.text);
  check("junk in front: the report says it was removed", r.lines.some((l) => /removed data in front of the PDF/.test(l)), r.lines);

  const trailing = join(plain, "\n<html><body>download page</body></html>\n".repeat(40), new Uint8Array(500).fill(0x9c));
  const t = await repaired(trailing);
  check("junk after the end: all 4 pages, text kept", t.read.pages === 4 && sameText(t.read, markers(4)), t.read.text);
  check("junk after the end: the report says it was removed", t.lines.some((l) => /removed data after its end/.test(l)), t.lines);

  // Every offset in the index points 37 bytes off.
  const shifted = edit(plain, /(\d{10}) 00000 n/g, (_m, n) => `${String(Number(n) + 37).padStart(10, "0")} 00000 n`);
  const o = await repaired(shifted);
  check("wrong offsets: all 4 pages, text kept", o.read.pages === 4 && sameText(o.read, markers(4)), o.read.text);
  check("wrong offsets: the report says the index was rebuilt", o.lines.some((l) => /rebuilt its broken index/.test(l)), o.lines);

  const badStart = edit(plain, /startxref\n\d+/, "startxref\n999999");
  const b = await repaired(badStart);
  check("startxref out of the file: all 4 pages", b.read.pages === 4 && sameText(b.read, markers(4)) && b.lines.some((l) => /index/.test(l)), b.lines);

  // The index and trailer deleted, startxref and %%EOF left.
  const noIndex = latin1(asText(plain).replace(/xref\n[\s\S]*?trailer\n<<[^>]*>>\n/, ""));
  const n = await repaired(noIndex);
  check("no index at all: all 4 pages, text kept", n.read.pages === 4 && sameText(n.read, markers(4)), n.read.text);

  const noRoot = edit(plain, "/Root 1 0 R", "");
  const nr = await repaired(noRoot);
  check("no /Root in the trailer: all 4 pages, text kept", nr.read.pages === 4 && sameText(nr.read, markers(4)), nr.read.text);

  // The catalog itself is gone: the pages are found by what they are.
  const noCatalog = edit(plain, "<< /Type /Catalog /Pages 2 0 R >>", "(lost)");
  const nc = await repaired(noCatalog);
  check("no catalog: every page found, in order", nc.read.pages === 4 && sameText(nc.read, markers(4)), nc.read.text);
  check("no catalog: the report says the page list was rebuilt", nc.lines.some((l) => /rebuilt its page list/.test(l)), nc.lines);
}

// ---------------------------------------------------------------------------
// The page tree: a loop, a page that isn't there, a node that isn't a node.
// ---------------------------------------------------------------------------
{
  // The tree lists itself among its pages: readers that follow it go round forever.
  const loop = edit(plain, "/Kids [4 0 R", "/Kids [2 0 R 4 0 R");
  const loopErr = await settle(PDFDocument.load(loop).then((d) => d.getPageCount()));
  check("page tree loop: pdf-lib alone fails on it", !!loopErr.error, loopErr.value);
  const r = await repaired(loop);
  check("page tree loop: each page once, in order", r.read.pages === 4 && sameText(r.read, markers(4)), r.read.text);
  check("page tree loop: the report says the page list was rebuilt", r.lines.some((l) => /rebuilt its page list/.test(l)), r.lines);

  // A nested loop: a child node whose kids lead back up.
  const nested = writePdf([
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [20 0 R 8 0 R] /Count 3 >>" },
    { num: 20, body: "<< /Type /Pages /Parent 2 0 R /Kids [4 0 R 6 0 R 2 0 R] /Count 2 >>" },
    ...layoutObjects({ pages: 3 }).slice(2).map((o) => ({ ...o, body: o.body.replace("/Parent 2 0 R", o.num === 8 ? "/Parent 2 0 R" : "/Parent 20 0 R") })),
  ]);
  const nl = await repaired(nested);
  check("nested loop: 3 pages, in order", nl.read.pages === 3 && sameText(nl.read, markers(3)), nl.read.text);

  // Page 3's dictionary is gone; the tree still says 4.
  const missing = edit(plain, /8 0 obj\n<<[^\n]*>>\nendobj\n/, "");
  const m = await repaired(missing);
  check("a page missing from the tree: the other 3 come back", m.read.pages === 3 && sameText(m.read, [1, 2, 4].map(pageText)), m.read.text);
  check("a page missing: the report says 3 of 4", m.lines[0] === "Recovered 3 of 4 pages.", m.lines);

  // Inherited size, rotation and resources from the tree survive the rebuild.
  const inherited = writePdf([
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [2 0 R 4 0 R 6 0 R] /Count 2 /MediaBox [0 0 400 300] /Rotate 90 /Resources << /Font << /F1 3 0 R >> >> >>" },
    { num: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { num: 4, body: "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>" },
    // Inside the 400 x 300 box: text off the page isn't read.
    { num: 5, body: "<< >>", stream: latin1(`BT /F1 18 Tf 40 150 Td (${pageText(1)}) Tj ET`) },
    { num: 6, body: "<< /Type /Page /Parent 2 0 R /Contents 7 0 R >>" },
    { num: 7, body: "<< >>", stream: latin1(`BT /F1 18 Tf 40 150 Td (${pageText(2)}) Tj ET`) },
  ]);
  const ih = await repaired(inherited);
  check("inherited size and rotation are kept", ih.read.pages === 2 && ih.read.sizes.every(([w, h]) => w === 300 && h === 400) && sameText(ih.read, markers(2)), ih.read);
}

// ---------------------------------------------------------------------------
// Cut off part way, as a download that stopped: at several points.
// ---------------------------------------------------------------------------
for (const flate of [false, true]) {
  const file = writePdf(layoutObjects({ pages: 6, flate }));
  const kind = flate ? "compressed" : "plain";
  // Just after page 3's content: pages 1-3 whole, the rest gone.
  const afterThree = offsetOf(file, "10 0 obj");
  const a = await repaired(file.slice(0, afterThree));
  check(`cut off after page 3 (${kind}): pages 1-3 come back with their text`, a.read.pages === 3 && sameText(a.read, markers(3)), a.read.text);
  check(`cut off after page 3 (${kind}): the report says 3 of 6, and that it was cut off`, a.lines[0] === "Recovered 3 of 6 pages." && a.lines.some((l) => /closed a file that was cut off/.test(l)), a.lines);

  // In the middle of page 4's content stream: what arrived of it is kept.
  const fourth = offsetOf(file, "11 0 obj");
  const streamAt = offsetOf(file.subarray(fourth), "stream\n") + fourth + 7;
  const mid = await repaired(file.slice(0, streamAt + (flate ? 30 : 40)));
  check(`cut off inside page 4's content (${kind}): 4 pages, the 4th marked as cut off`, mid.read.pages === 4 && mid.report.partial.join() === "4", { pages: mid.read.pages, partial: mid.report.partial, lines: mid.lines });
  check(`cut off inside page 4's content (${kind}): the report says so`, mid.lines.some((l) => /^Page 4 was cut off/.test(l)), mid.lines);

  check(`cut off after page 3 (${kind}): the report warns that what was kept at the end may be gone`, a.lines.some((l) => /The end of the file was missing/.test(l)), a.lines);

  // In the index, after every object: nothing is lost, and the report doesn't say so.
  const inIndex = await repaired(file.slice(0, offsetOf(file, "xref") + 30));
  check(`cut off in the index (${kind}): all 6 pages`, inIndex.read.pages === 6 && sameText(inIndex.read, markers(6)), inIndex.read.text);
  check(`cut off in the index (${kind}): no warning that anything is gone`, !repairLines(inIndex.report).some((l) => l.warn), inIndex.lines);

  // A few bytes short: only %%EOF lost.
  const short = await repaired(file.slice(0, file.length - 4));
  check(`cut off at the very end (${kind}): all 6 pages`, short.read.pages === 6 && sameText(short.read, markers(6)), short.read.text);

  // Before any page arrived: refused, not a blank page.
  const early = await settle(repair(file.slice(0, offsetOf(file, "4 0 obj") + 5)));
  check(`cut off before any page (${kind}): nothing recovered, said plainly`, !early.value && /Nothing in this file could be recovered|too damaged/.test(early.error?.message ?? ""), early.error?.message);
}

// The partial inflate keeps what arrived up to the last whole line.
{
  const text = latin1(Array.from({ length: 400 }, (_, i) => `BT /F1 9 Tf 10 ${i} Td (line ${i}) Tj ET`).join("\n") + "\n");
  const packed = new Uint8Array(deflateSync(text));
  const half = inflateUpToDamage(packed.subarray(0, packed.length >> 1));
  check("inflate up to damage: keeps a start that ends on a whole line", !!half && half.length > 1000 && half.length < text.length && half[half.length - 1] === 0x0a, half?.length);
  check("inflate up to damage: nothing from junk", inflateUpToDamage(new Uint8Array(64).fill(7)) === null);
}

// ---------------------------------------------------------------------------
// Object streams: the catalog, the page list, the pages and the font packed
// in one compressed stream, which neither reader gets past when it's damaged.
// ---------------------------------------------------------------------------
/** A file pdf-lib writes, with `pages` pages of text, its objects packed in an object stream. */
async function packed(pages: number, opts: { objectStreams?: boolean } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) doc.addPage([600, 800]).drawText(pageText(i), { x: 50, y: 700, size: 20, font });
  return doc.save({ useObjectStreams: opts.objectStreams ?? true });
}
/** Where the object stream's data starts and ends. */
function objStm(bytes: Uint8Array) {
  const s = asText(bytes);
  const at = s.indexOf("/ObjStm");
  const data = s.indexOf("stream\n", at) + 7;
  return { at, data, end: s.indexOf("endstream", data) - 1 };
}
const pdfjsOpens = async (bytes: Uint8Array) =>
  pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS, isEvalSupported: false }).promise.then((d) => (d.destroy(), true), () => false);
{
  const file = await packed(5);
  const { data, end } = objStm(file);

  const firstOff = edit(file, /\/First (\d+)/, (_m, n) => `/First ${Number(n) + 7}`);
  check("object stream with a wrong start: neither reader opens it as it is", !(await pdfjsOpens(firstOff)) && !(await settle(PDFDocument.load(firstOff).then((d) => d.getPageCount()))).value);
  const f = await repaired(firstOff);
  check("object stream with a wrong start: all 5 pages, text kept", f.read.pages === 5 && sameText(f.read, markers(5)), f.read.text);
  check("object stream with a wrong start: the report says so", f.lines.some((l) => /recovered objects from a damaged compressed part/.test(l)), f.lines);

  const countOff = edit(file, /\/N (\d+)/, (_m, n) => `/N ${Number(n) + 3}`);
  const c = await repaired(countOff);
  check("object stream with a wrong count: all 5 pages, text kept", c.read.pages === 5 && sameText(c.read, markers(5)), c.read.text);

  const noHeader = file.slice();
  noHeader[data] = noHeader[data + 1] = 0;
  const h = await repaired(noHeader);
  check("object stream with a damaged compression header: all 5 pages", h.read.pages === 5 && sameText(h.read, markers(5)), h.read.text);

  // Its last part missing: the objects that arrived whole come back, the page tree among them.
  const cut = await repaired(file.slice(0, data + Math.round((end - data) * 0.95)));
  check("cut off inside the object stream: the pages whose objects arrived come back", cut.read.pages >= 1 && cut.read.pages < 5 && cut.read.text.every((t, i) => t.includes(pageText(i + 1))), { pages: cut.read.pages, text: cut.read.text });
  check("cut off inside the object stream: the report says how many of 5", cut.lines[0] === `Recovered ${cut.read.pages} of 5 pages.`, cut.lines);

  // Damaged from its start: what inflates is nonsense, and nonsense is not passed off as pages.
  const garbled = file.slice();
  for (let i = data + 2; i < end; i++) garbled[i] ^= 0x5a;
  const g = await settle(repair(garbled));
  check("object stream garbled throughout: nothing recovered, said plainly", !g.value && /Nothing in this file could be recovered|too damaged/.test(g.error?.message ?? ""), g.error?.message);

  // A healthy object stream is left as it is.
  const fine = await repaired(file);
  check("healthy object stream: no damage found", fine.read.pages === 5 && fine.lines.length === 1 && /^No damage found/.test(fine.lines[0]), fine.lines);
}

// ---------------------------------------------------------------------------
// A real-looking file: mixed sizes, turned pages, form fields, a web link and
// a bookmark, with its index wrong and junk around it. Everything is kept.
// ---------------------------------------------------------------------------
const SIZES: [number, number][] = [[595, 842], [612, 792], [842, 595], [612, 1008], [420, 595], [595, 842]];
const ROTATE = [0, 90, 0, 180, 270, 0];
async function richFile(opts: { courierOn?: number } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const form = doc.getForm();
  SIZES.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.setRotation(degrees(ROTATE[i]));
    page.drawText(pageText(i + 1), { x: 40, y: h - 80, size: 18, font: opts.courierOn === i + 1 ? courier : font });
    page.drawRectangle({ x: 40, y: 40, width: 120, height: 60, color: rgb(0.2, 0.4, 0.8) });
  });
  const [p1, p2, p3, p4] = doc.getPages();
  const name = form.createTextField("name");
  name.setText("Ada Lovelace");
  name.addToPage(p1, { x: 40, y: 300, width: 200, height: 24 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(p1, { x: 40, y: 260, width: 18, height: 18 });
  agree.check();
  const notes = form.createTextField("notes");
  notes.setText("third page note");
  notes.addToPage(p3, { x: 40, y: 300, width: 200, height: 24 });
  const ctx = doc.context;
  const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 400, 240, 420], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/") } }));
  p2.node.set(PDFName.of("Annots"), ctx.obj([link]));
  const outlines = ctx.nextRef();
  const item = ctx.register(ctx.obj({ Title: PDFString.of("Chapter four"), Parent: outlines, Dest: [p4.ref, "Fit"] }));
  ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  return doc.save({ useObjectStreams: false });
}

/** What pdf-lib reads of fields, links and bookmarks, and pdf.js of rotation. */
async function extrasOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const fields = Object.fromEntries(
    doc.getForm().getFields().map((f) => [f.getName(), "getText" in f ? (f as { getText(): string | undefined }).getText() : "isChecked" in f ? (f as { isChecked(): boolean }).isChecked() : null])
  );
  const js = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS, isEvalSupported: false }).promise;
  const rotations: number[] = [];
  const links: string[] = [];
  for (let i = 1; i <= js.numPages; i++) {
    const page = await js.getPage(i);
    rotations.push(page.rotate);
    for (const a of await page.getAnnotations()) if (a.subtype === "Link" && a.url) links.push(`${i}:${a.url}`);
  }
  const outline = (await js.getOutline()) ?? [];
  const bookmarkPage = outline[0]?.dest ? (await js.getPageIndex((outline[0].dest as { num: number; gen: number }[])[0])) + 1 : 0;
  await js.destroy();
  return { fields, rotations, links, bookmarks: outline.map((o) => o.title), bookmarkPage };
}

const rich = await richFile();
{
  const damaged = join(
    "%!PS-Adobe junk from a mail gateway\n",
    edit(rich, /(\d{10}) 00000 n/g, (_m, n) => `${String(Number(n) + 11).padStart(10, "0")} 00000 n`),
    "\n--boundary--\n"
  );
  const r = await repaired(damaged);
  const want = SIZES.map(([w, h], i) => (ROTATE[i] % 180 ? [h, w] : [w, h]));
  check("rich file: 6 pages, each its own size as shown (turned pages too)", r.read.pages === 6 && r.read.sizes.every(([w, h], i) => w === want[i][0] && h === want[i][1]), r.read.sizes);
  check("rich file: the text of every page", sameText(r.read, markers(6)), r.read.text);
  const ex = await extrasOf(r.out);
  check("rich file: rotation kept as /Rotate", ex.rotations.join() === ROTATE.join(), ex.rotations);
  check("rich file: form fields and their values kept", ex.fields.name === "Ada Lovelace" && ex.fields.agree === true && ex.fields.notes === "third page note", ex.fields);
  check("rich file: the web link kept", ex.links.join() === "2:https://example.com/", ex.links);
  check("rich file: the bookmark kept, leading to page 4", ex.bookmarks.join() === "Chapter four" && ex.bookmarkPage === 4, ex);
  check("rich file: no page is a picture, nothing reported lost", !r.report.pictures.length && !r.report.lost.length && !repairLines(r.report).some((l) => l.warn), r.lines);
  check("rich file: the report names what was fixed", r.lines.some((l) => /removed data in front of the PDF/.test(l)) && r.lines.some((l) => /removed data after its end/.test(l)) && r.lines.some((l) => /rebuilt its broken index/.test(l)), r.lines);
}

// Objects lost from the middle (a field, a bookmark's target page, the info
// dictionary): what points at them is cut loose, never pointed somewhere else.
{
  const s = asText(rich);
  const objectOf = (needle: string) => {
    const at = s.indexOf(needle);
    const start = s.lastIndexOf("\n", s.lastIndexOf(" 0 obj", at)) + 1;
    return s.slice(start, s.indexOf("endobj", at) + 6);
  };
  const notes = objectOf("/T <FEFF006E006F007400650073>");
  const info = objectOf("/Producer");
  const holed = latin1(s.replace(notes, "").replace(info, ""));
  const r = await repaired(holed);
  const ex = await extrasOf(r.out);
  check("objects lost from the middle: 6 pages, text kept", r.read.pages === 6 && sameText(r.read, markers(6)), r.read.text);
  check("objects lost from the middle: the form reads, with the fields that are there", ex.fields.name === "Ada Lovelace" && ex.fields.agree === true && Object.keys(ex.fields).length === 2, ex.fields);
  const doc = await PDFDocument.load(r.out);
  const infoRef = doc.context.trailerInfo.Info;
  check("objects lost from the middle: the info entry leads to an info dictionary or nowhere", !infoRef || doc.context.lookup(infoRef) instanceof PDFDict && !doc.context.lookup(infoRef, PDFDict).has(PDFName.of("FT")));
}

// ---------------------------------------------------------------------------
// A page pdf-lib can't copy (its font is damaged) is drawn by pdf.js as a
// picture, its text laid over it; the other pages stay as they were.
// ---------------------------------------------------------------------------
const imagesOn = async (bytes: Uint8Array) => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const xobjects = p.node.Resources()?.lookup(PDFName.of("XObject"));
    return xobjects instanceof PDFDict ? xobjects.keys().length : 0;
  });
};
if (canvasMod) {
  const withCourier = await richFile({ courierOn: 3 });
  // Courier is used by page 3 alone: its font dictionary is made unreadable.
  const s = asText(withCourier);
  const fontAt = s.indexOf("/BaseFont /Courier");
  const objAt = s.lastIndexOf(" 0 obj", fontAt);
  const broken = latin1(s.slice(0, objAt) + " 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding << /Differences [ 1 (" + s.slice(s.indexOf("endobj", fontAt)));
  const progress: number[] = [];
  const { bytes: out, report } = await repairPdf(blob(broken), { progress: (f) => progress.push(f) });
  const read = await readBoth(out);
  const lines = repairLines(report).map((l) => l.text);
  check("damaged font: all 6 pages, in order", read.pages === 6 && read.lib === 6, read);
  check("damaged font: page 3 became a picture, the others did not", report.pictures.join() === "3" && (await imagesOn(out)).map((n, i) => (i === 2 ? n > 0 : n === 0)).every(Boolean), { pictures: report.pictures, images: await imagesOn(out) });
  check("damaged font: page 3's text can still be searched", report.searchable.join() === "3" && read.text[2].includes(pageText(3)), read.text[2]);
  check("damaged font: the text of the other pages is as it was", [0, 1, 3, 4, 5].every((i) => read.text[i].includes(pageText(i + 1))), read.text);
  const want = SIZES.map(([w, h], i) => (ROTATE[i] % 180 ? [h, w] : [w, h]));
  check("damaged font: every page keeps its size as shown", read.sizes.every(([w, h], i) => Math.abs(w - want[i][0]) <= 1 && Math.abs(h - want[i][1]) <= 1), read.sizes);
  const ex = await extrasOf(out);
  check("damaged font: the fields of the other pages can still be filled in", ex.fields.name === "Ada Lovelace" && ex.fields.agree === true && !("notes" in ex.fields), ex.fields);
  check("damaged font: the bookmark still leads to page 4, the link is kept", ex.bookmarkPage === 4 && ex.links.join() === "2:https://example.com/", ex);
  check("damaged font: the report says page 3 is a picture with searchable text", lines.includes("Page 3 is a picture now; its text can still be searched."), lines);
  check("damaged font: the report says a form field was lost", lines.includes("2 of 3 form fields can still be filled in."), lines);
  check("damaged font: progress goes from start to end", progress.length > 3 && progress[0] < 0.1 && progress.at(-1)! >= 0.9 && progress.every((f, i) => i === 0 || f >= progress[i - 1] - 1e-9), progress);

  // Page 2's content stream is garbage from its first byte: nothing of it can be drawn.
  const doc = writePdf(layoutObjects({ pages: 3, flate: true }).map((o) => (o.num === 7 ? { ...o, stream: new Uint8Array(200).fill(0xa7) } : o)));
  const lost = await repairPdf(blob(doc));
  const lr = await readBoth(lost.bytes);
  const ll = repairLines(lost.report).map((l) => l.text);
  check("unreadable page content: the other 2 pages come back, in order", lr.pages === 2 && sameText(lr, [pageText(1), pageText(3)]), lr.text);
  check("unreadable page content: the report says page 2 was left out", ll[0] === "Recovered 2 of 3 pages." && ll.includes("Page 2 of the original couldn't be read and is left out."), ll);

  // Every page's font damaged: every page a picture, the file still opens with its text.
  const allBroken = writePdf(layoutObjects({ pages: 3 }).map((o) => (o.num === 3 ? { ...o, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Widths [ 1 2" } : o)));
  const all = await repairPdf(blob(allBroken));
  const ar = await readBoth(all.bytes);
  check("every page damaged: 3 pictures, text searchable", ar.pages === 3 && all.report.pictures.join() === "1,2,3" && sameText(ar, markers(3)), { pictures: all.report.pictures, text: ar.text });
  check("every page damaged: the report says so in one line", repairLines(all.report).some((l) => l.text === "Pages 1–3 are pictures now; their text can still be searched."), repairLines(all.report));
} else {
  console.log("SKIP  pictures of damaged pages: the canvas package isn't installed");
}

// ---------------------------------------------------------------------------
// Passwords: one that opens without a password is repaired and comes out
// unlocked; one that needs a password is sent to Unlock PDF first.
// ---------------------------------------------------------------------------
{
  const restricted = await SecurePDFDocument.load(rich);
  restricted.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false, copying: false, modifying: false } });
  const locked = await restricted.save({ useObjectStreams: false });
  const damaged = join("junk\r\n", locked.slice(0, locked.length - 6));
  const r = await repaired(damaged);
  check("owner password only, damaged: all 6 pages with their text", r.read.pages === 6 && sameText(r.read, markers(6)), r.read.text);
  // (The encryptor used here leaves field names in the clear, so they don't decrypt: only pages are checked.)
  check("owner password only: each page keeps its turn", (await extrasOf(r.out)).rotations.join() === ROTATE.join());
  check("owner password only: the repaired file isn't encrypted", !(await PDFDocument.load(r.out)).isEncrypted);

  const needs = await SecurePDFDocument.load(rich);
  needs.encrypt({ userPassword: "open sesame", ownerPassword: "owner" });
  const pw = await needs.save({ useObjectStreams: false });
  for (const [name, bytes] of [["as it is", pw], ["junk in front", join("junk\n", pw)], ["cut off before its end", pw.slice(0, pw.length - 6)]] as const) {
    const e = await settle(repair(bytes));
    check(`needs a password (${name}): sent to Unlock PDF, no file made`, !e.value && e.error?.message === NEEDS_UNLOCK, e.error?.message);
  }
  // Cut off before its trailer: its ID, which decrypting needs, is gone.
  const e = await settle(repair(pw.slice(0, pw.length - 300)));
  check("encrypted, cut off before its trailer: said plainly, no file made", !e.value && (e.error?.message === NEEDS_UNLOCK || /locked with encryption, and the part needed to unlock it is damaged/.test(e.error?.message ?? "")), e.error?.message);
}

// ---------------------------------------------------------------------------
// Not a PDF, an empty file, a PDF of nothing: plain messages, no file.
// ---------------------------------------------------------------------------
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(200).fill(1)]);
  const e1 = await settle(repair(png));
  check("not a PDF: said so", !e1.value && /isn't a PDF/.test(e1.error?.message ?? ""), e1.error?.message);
  const e2 = await settle(repair(new Uint8Array(0)));
  check("empty file: said so", !e2.value && /empty/.test(e2.error?.message ?? ""), e2.error?.message);
  const e3 = await settle(repair(latin1("%PDF-1.7\n%%EOF\n")));
  check("a header and nothing else: nothing recovered, no blank page", !e3.value && /Nothing in this file could be recovered|too damaged/.test(e3.error?.message ?? ""), e3.error?.message);
  // Pages with nothing on them at all: not passed off as a recovered file.
  const blank = await PDFDocument.create();
  blank.addPage();
  blank.addPage();
  const e4 = await settle(repair(await blank.save()));
  check("only blank pages: nothing recovered, no blank PDF", !e4.value && /Nothing in this file could be recovered/.test(e4.error?.message ?? ""), e4.error?.message);
  // Without a header but with its objects: the start is put back.
  const headless = plain.slice(asText(plain).indexOf("1 0 obj"));
  const hl = await repaired(headless);
  check("missing header: all 4 pages, and the report says the start was added", hl.read.pages === 4 && sameText(hl.read, markers(4)) && hl.lines.some((l) => /added its missing start/.test(l)), hl.lines);
}

// ---------------------------------------------------------------------------
// Many pages, cut off part way: what arrived comes back, quickly enough, and
// Cancel stops it.
// ---------------------------------------------------------------------------
{
  const many = writePdf(layoutObjects({ pages: 400, flate: true }));
  // Page 301's dictionary is object 604.
  const at = offsetOf(many, "\n604 0 obj") + 1;
  const started = performance.now();
  const r = await repaired(many.slice(0, at));
  const seconds = (performance.now() - started) / 1000;
  check("400 pages cut off after page 300: those 300 come back", r.read.pages === 300 && sameText(r.read, markers(300)), { pages: r.read.pages });
  check("400 pages cut off: the report says how many of 400", new RegExp(`^Recovered ${r.read.pages} of 400 pages\\.$`).test(r.lines[0]), r.lines);
  check("400 pages: repaired in a reasonable time", seconds < 30, seconds);

  const ctl = new AbortController();
  const stopped = await settle(repairPdf(blob(many), { signal: ctl.signal, progress: () => ctl.abort() }));
  check("Cancel stops the repair: no file", !stopped.value && stopped.error?.name === "AbortError", stopped.error?.name);
}

// ---------------------------------------------------------------------------
// The report's page lists.
// ---------------------------------------------------------------------------
check("page list: one page", pageList([3]) === "3");
check("page list: two pages", pageList([5, 2]) === "2 and 5");
check("page list: a run and singles", pageList([1, 2, 3, 4, 7, 9]) === "1–4, 7 and 9", pageList([1, 2, 3, 4, 7, 9]));
check("page list: two in a row stay apart", pageList([1, 2, 5]) === "1, 2 and 5", pageList([1, 2, 5]));

// ---------------------------------------------------------------------------
// The tool: a file named for what was done, the report's lines, its errors
// as they are; and listed where tools are.
// ---------------------------------------------------------------------------
{
  const { repairTool } = await import("../lib/pdf/toolkit.ts");
  const file = new File([join("junk\n", plain) as Uint8Array<ArrayBuffer>], "Scan 12.pdf", { type: "application/pdf" });
  const out = await repairTool([file]);
  check("tool: named after the file", out.filename === "Scan 12-repaired.pdf", out.filename);
  check("tool: a PDF with all 4 pages", out.blob.type === "application/pdf" && (await readBoth(new Uint8Array(await out.blob.arrayBuffer()))).pages === 4);
  check("tool: the report's lines come with it", out.report?.[0]?.text === "Recovered all 4 pages." && out.report.some((l) => /removed data in front/.test(l.text)), out.report);
  const none = await settle(repairTool([new File([latin1("hello")], "notes.pdf")]));
  check("tool: not a PDF keeps its own message", /isn't a PDF/.test(none.error?.message ?? ""), none.error?.message);
  const { friendlyPdfError } = await import("../lib/pdf/errors.ts");
  check("tool: its messages pass the page's error wording as they are", [NEEDS_UNLOCK, "This PDF is locked with encryption, and the part needed to unlock it is damaged, so nothing in it could be recovered.", "Nothing in this file could be recovered: its pages can't be read or are blank."].every((m) => friendlyPdfError(new Error(m)).message === m));

  const { getTool, TOOLS } = await import("../lib/tools.tsx");
  const { PROCESSORS } = await import("../components/tools/processors.ts");
  const { panelSpec } = await import("../components/tools/panel-spec.tsx");
  const { filterTools } = await import("../components/tool-filter.ts");
  const sitemapModule = await import("../app/sitemap.ts");
  // The app files are CommonJS to tsx here, so the default export may arrive wrapped.
  let sitemap: unknown = sitemapModule.default;
  while (typeof sitemap !== "function") sitemap = (sitemap as { default: unknown }).default;
  const urls = (sitemap as () => { url: string }[])().map((e) => e.url);
  check("in the sitemap", urls.some((u) => u.endsWith("/tools/repair-pdf")));
  const tool = getTool("repair-pdf");
  check("registered once, under Optimize", !!tool && tool.category === "optimize" && TOOLS.filter((t) => t.slug === "repair-pdf").length === 1);
  check("a workbench tool for one PDF that can be cancelled", !!tool && panelSpec(tool).kind === "workbench" && !!PROCESSORS["repair-pdf"]?.cancellable && !PROCESSORS["repair-pdf"].multiple && PROCESSORS["repair-pdf"].accept === "application/pdf");
  check("search finds it by what people type", ["repair", "fix pdf", "corrupt", "damaged", "won't open", "recover"].every((q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "repair-pdf")));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
