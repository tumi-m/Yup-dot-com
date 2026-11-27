process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// PDF to PDF/A: awkward files (standard fonts and Arial not embedded, Type3
// and CID fonts, forms and comments, scripts, attachments, owner and user
// passwords, transparency, CMYK, LZW, operators PDF doesn't define, turned
// and mixed-size pages, a broken file, a file already PDF/A) come out with
// an sRGB output intent, PDF/A XMP, every visible font embedded, no scripts,
// attachments or encryption, the same pages at the same sizes, and text that
// pdf.js still reads. Our own check is run too, and must pass.
//
// Set PDFA_OUT to a folder to keep the results (to check them with veraPDF).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, PDFString, StandardFontEmbedder, StandardFonts, degrees, rgb } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

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
const canvasMod = await import("canvas");
const makeCanvas = () => Object.assign(canvasMod.createCanvas(1, 1), { style: {} }) as unknown as HTMLCanvasElement;
(globalThis as Record<string, unknown>).document = { createElement: makeCanvas };

const { convertToPdfa, pdfaLines, PasswordError, NEEDS_PASSWORD, WRONG_PASSWORD } = await import("../lib/pdf/pdfa/index.ts");
const { nameToText, baseName } = await import("../lib/pdf/pdfa/glyph-names.ts");
const { TrueTypeFont, writeSubset } = await import("../lib/pdf/pdfa/truetype.ts");
const { jpxOk } = await import("../lib/pdf/pdfa/colour.ts");

const OUT = process.env.PDFA_OUT;
if (OUT) mkdirSync(OUT, { recursive: true });
const N = PDFName.of;
const STD = "./node_modules/pdfjs-dist/standard_fonts/";
const fonts = async (file: string) => new Uint8Array(readFileSync(`./node_modules/@fontsource/${file.split("-")[0]}/files/${file}`));
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));
const blob = (b: Uint8Array) => new Blob([b as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
const convert = (bytes: Uint8Array, opts: { part?: 2 | 3; password?: string } = {}) =>
  convertToPdfa(blob(bytes), { part: opts.part ?? 2, password: opts.password, fonts, canvas: makeCanvas });

function rawPage(doc: PDFDocument, size: [number, number], ops: string, resources: Record<string, unknown> = {}) {
  const page = doc.addPage(size);
  page.node.set(N("Resources"), doc.context.obj(resources as never));
  page.node.set(N("Contents"), doc.context.register(doc.context.flateStream(ops)));
  return page;
}

/** Pages, sizes and text as pdf.js reads them. */
async function read(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: STD, isEvalSupported: false }).promise;
  const text: string[] = [];
  const sizes: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push(`${Math.round(vp.width)}x${Math.round(vp.height)}`);
    const c = await page.getTextContent();
    text.push(c.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " "));
  }
  const attachments = await doc.getAttachments();
  await doc.destroy();
  return { pages: text.length, text, sizes, attachments: attachments ? Object.keys(attachments).length : 0 };
}

/** What the PDF/A rules this tool covers say about a result, read independently with pdf-lib. */
async function inspect(bytes: Uint8Array, part = 2) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const oi = doc.catalog.lookup(N("OutputIntents"));
  const intent = oi instanceof PDFArray ? oi.lookup(0) : undefined;
  const profile = intent instanceof PDFDict ? intent.lookup(N("DestOutputProfile")) : undefined;
  const meta = doc.catalog.lookup(N("Metadata"));
  const xmp = meta instanceof PDFStream ? new TextDecoder().decode((meta as unknown as { contents: Uint8Array }).contents) : "";
  let notEmbedded: string[] = [];
  let scripts = 0;
  let ef = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const d = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!d) continue;
    if (d.lookup(N("S")) === N("JavaScript") || d.has(N("JS"))) scripts++;
    if (d.has(N("EF"))) ef++;
    if (d.lookup(N("Type")) === N("FontDescriptor") && !["FontFile", "FontFile2", "FontFile3"].some((k) => d.has(N(k)))) {
      notEmbedded.push((d.lookup(N("FontName")) as PDFName | undefined)?.decodeText() ?? "?");
    }
    // Fonts with no descriptor at all: only the invisible text layer's Helvetica may be one.
    if (d.lookup(N("Type")) === N("Font") && !d.has(N("FontDescriptor")) && !d.has(N("DescendantFonts")) && d.lookup(N("Subtype")) !== N("Type3")) {
      const base = (d.lookup(N("BaseFont")) as PDFName | undefined)?.decodeText();
      if (base !== "Helvetica") notEmbedded.push(base ?? "?");
    }
  }
  notEmbedded = [...new Set(notEmbedded)];
  const names = doc.catalog.lookup(N("Names"));
  return {
    srgb: intent instanceof PDFDict && intent.lookup(N("S")) === N("GTS_PDFA1") && profile instanceof PDFStream && (profile.dict.lookup(N("N")) as PDFNumber).asNumber() === 3,
    xmp: xmp.includes(`<pdfaid:part>${part}</pdfaid:part>`) && xmp.includes("<pdfaid:conformance>B</pdfaid:conformance>"),
    title: (() => {
      try {
        return doc.getTitle();
      } catch {
        return undefined;
      }
    })(),
    xmpText: xmp,
    id: ctx.lookup(ctx.trailerInfo.ID) instanceof PDFArray,
    encrypted: !!ctx.trailerInfo.Encrypt,
    notEmbedded,
    scripts: scripts + (names instanceof PDFDict && names.has(N("JavaScript")) ? 1 : 0),
    ef,
    openAction: doc.catalog.has(N("OpenAction")),
    acroForm: doc.catalog.has(N("AcroForm")),
    header: String.fromCharCode(...bytes.subarray(0, 8)),
    doc,
  };
}

const saved: string[] = [];
async function common(label: string, input: Uint8Array, result: Awaited<ReturnType<typeof convert>>, part = 2, opts: { password?: string } = {}) {
  if (OUT) {
    const file = `${OUT}/${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${part}b.pdf`;
    writeFileSync(file, result.bytes);
    saved.push(file);
  }
  const i = await inspect(result.bytes, part);
  check(`${label}: sRGB output intent`, i.srgb);
  check(`${label}: XMP says PDF/A-${part}b`, i.xmp);
  check(`${label}: file identifier, not encrypted, header ${i.header}`, i.id && !i.encrypted && /^%PDF-1\.[0-7]$/.test(i.header));
  check(`${label}: every font that draws is embedded`, !i.notEmbedded.length, i.notEmbedded);
  check(`${label}: no scripts`, !i.scripts && !i.openAction, i.scripts);
  check(`${label}: our own check passes`, result.checks.every((c) => c.ok), result.checks.filter((c) => !c.ok));
  const before = await read(opts.password ? await (async () => {
    const d = await SecurePDFDocument.load(input, { password: opts.password });
    return d.save();
  })() : input);
  const after = await read(result.bytes);
  check(`${label}: same pages at the same sizes`, before.pages === after.pages && before.sizes.join() === after.sizes.join(), { before: before.sizes, after: after.sizes });
  return { i, before, after };
}

// --- Glyph names and the TrueType writer ----------------------------------------------
check("glyph names: standard, accented, uni, ligature, suffix", nameToText("eacute") === "é" && nameToText("Scaron") === "Š" && nameToText("uni20AC") === "€" && nameToText("f_i") === "fi" && nameToText("a.sc") === "a" && nameToText("Gcommaaccent") === "Ģ" && nameToText("nonsense") === null);
check("encodings: StandardEncoding quoteright, WinAnsi 0x80 Euro, MacRoman 0x8E eacute", baseName("StandardEncoding", 39) === "quoteright" && baseName("WinAnsiEncoding", 0x80) === "Euro" && baseName("MacRomanEncoding", 0x8e) === "eacute");
{
  const arimo = TrueTypeFont.from(await fonts("arimo-latin-400-normal.woff"))!;
  const a = arimo.glyphFor(0x41);
  const ttf = writeSubset([{ code: 0x41, parts: [a], font: arimo, width: 700 }, { code: 0x80, parts: [arimo.glyphFor(0x66), arimo.glyphFor(0x69)], font: arimo, width: 500 }], "AAAAAA+Arimo");
  const back = TrueTypeFont.from(ttf)!;
  check("subset: codes reach their glyphs through a (3,0) cmap", back.symbolGlyph(0x41) > 0 && back.symbolGlyph(0x80) > 0 && back.symbolGlyph(0x42) === 0);
  check("subset: each glyph is as wide as the PDF says", Math.abs((back.advance(back.symbolGlyph(0x41)) * 1000) / back.unitsPerEm - 700) <= 1 && Math.abs((back.advance(back.symbolGlyph(0x80)) * 1000) / back.unitsPerEm - 500) <= 1);
  check("subset: much smaller than the source", ttf.length < 6000, ttf.length);
}
check("JPEG 2000: four channels of one depth pass, two channels fail", jpxOk(jp2(3), true) && !jpxOk(jp2(2), true));

function jp2(channels: number): Uint8Array {
  const box = (type: string, body: number[]) => [0, 0, 0, 8 + body.length, ...[...type].map((c) => c.charCodeAt(0)), ...body];
  const ihdr = box("ihdr", [0, 0, 0, 10, 0, 0, 0, 10, 0, channels, 7, 7, 0, 0]);
  const colr = box("colr", [1, 0, 0, 0, 0, 0, 16]);
  return Uint8Array.from([...box("jP  ", [13, 10, 135, 10]), ...box("jp2h", [...ihdr, ...colr])]);
}

// --- Standard 14 fonts not embedded, Arial named but not embedded, OCR text ---------------
{
  const doc = await PDFDocument.create();
  doc.setTitle("Report & <Plan>");
  doc.setAuthor("Thandi Nkosi");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const p1 = doc.addPage([595, 842]);
  p1.drawText("Helvetica café — “quotes” € Œ", { x: 50, y: 760, size: 16, font: helv });
  p1.drawText("Times bold italic text", { x: 50, y: 720, size: 16, font: times });
  p1.drawText("Courier mono 0123", { x: 50, y: 680, size: 16, font: courier });
  // Arial as Word leaves it: TrueType, WinAnsi, widths, no program.
  // Arial's widths are Helvetica's.
  const afm = StandardFontEmbedder.for(StandardFonts.Helvetica as never);
  const widths = Array.from({ length: 95 }, (_, i) => Math.round(afm.widthOfTextAtSize(String.fromCharCode(32 + i), 1000)));
  const arial = doc.context.register(
    doc.context.obj({
      Type: "Font", Subtype: "TrueType", BaseFont: "ArialMT", Encoding: "WinAnsiEncoding", FirstChar: 32, LastChar: 126, Widths: widths,
      FontDescriptor: { Type: "FontDescriptor", FontName: "ArialMT", Flags: 32, FontBBox: [-665, -325, 2000, 1040], ItalicAngle: 0, Ascent: 905, Descent: -212, CapHeight: 716, StemV: 80 },
    })
  );
  const ocr = doc.context.register(doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  rawPage(doc, [612, 792], "BT /A 14 Tf 72 700 Td (Arial from a word processor) Tj ET BT 3 Tr /O 10 Tf 72 600 Td (invisible scanned words) Tj ET", { Font: { A: arial, O: ocr } });
  const input = await doc.save();
  const result = await convert(input);
  const { after, i } = await common("standard fonts", input, result);
  check("standard fonts: text still reads", after.text[0].includes("Helvetica café") && after.text[0].includes("Courier mono 0123") && after.text[1].includes("Arial from a word processor") && after.text[1].includes("invisible scanned words"), after.text);
  check("standard fonts: no page became a picture", result.facts.pictures.length === 0, result.facts.pictures);
  check("standard fonts: Helvetica, Times, Courier and Arial got substitutes", ["Arimo", "Tinos-BoldItalic", "Cousine"].every((n) => result.facts.substituted.some((s) => s.to === n)) && result.facts.substituted.some((s) => s.from === "ArialMT"), result.facts.substituted);
  check("standard fonts: the title is the same in Info and XMP", i.title === "Report & <Plan>" && i.xmpText.includes("Report &amp; &lt;Plan&gt;") && i.xmpText.includes("<rdf:li>Thandi Nkosi</rdf:li>"));
  check("standard fonts: the report says what our check found and points at veraPDF", pdfaLines(result).some((l) => l.text === "Embedded fonts: OK") && pdfaLines(result).at(-1)!.text.includes("veraPDF"));
  // Already PDF/A: converting again changes nothing that matters and says so.
  const again = await convert(result.bytes);
  await common("already PDF/A", result.bytes, again);
  check("already PDF/A: the report says what it was", again.facts.claimed === "PDF/A-2b" && pdfaLines(again).some((l) => l.text.includes("said it was PDF/A-2b")));
}

// --- Type3 and CID fonts, transparency, CMYK, turned and mixed-size pages ------------------
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const ctx = doc.context;
  const glyph = (w: number) => ctx.register(ctx.flateStream(`${w} 0 0 0 ${w} 700 d1 50 0 ${w - 100} 700 re f`));
  const type3 = ctx.register(
    ctx.obj({
      Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 600, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { A: glyph(600), B: glyph(500) }, Encoding: { Type: "Encoding", Differences: [65, N("A"), N("B")] },
      FirstChar: 65, LastChar: 66, Widths: [600, 500], Resources: {},
    })
  );
  rawPage(doc, [612, 792], "BT /T3 20 Tf 72 700 Td (ABAB) Tj ET", { Font: { T3: type3 } });
  const cid = await doc.embedFont(readFileSync(STD + "LiberationSans-Regular.ttf"), { subset: true });
  const turned = doc.addPage([400, 300]);
  turned.setRotation(degrees(90));
  turned.drawText("CID font on a turned page", { x: 30, y: 150, size: 14, font: cid });
  const glass = doc.addPage([842, 595]);
  glass.drawRectangle({ x: 50, y: 50, width: 300, height: 200, color: rgb(0, 0.5, 1), opacity: 0.4 });
  glass.drawText("Transparent and landscape", { x: 60, y: 300, size: 14, font: cid });
  // CMYK colour and a blend mode PDF doesn't define.
  const gs = ctx.obj({ Type: "ExtGState", BM: N("Glow"), ca: 0.8 });
  rawPage(doc, [300, 400], "q /G1 gs 0.1 0.9 0.1 0 k 20 20 200 200 re f Q", { ExtGState: { G1: gs } });
  const input = await doc.save();
  const result = await convert(input);
  const { after, i } = await common("Type3, CID, transparency, CMYK", input, result);
  check("Type3 and CID: text still reads", after.text[1].includes("CID font on a turned page") && after.text[2].includes("Transparent and landscape"), after.text);
  check("Type3, CID: no page became a picture", result.facts.pictures.length === 0, result.facts.pictures);
  const res = i.doc.getPage(3).node.Resources()!;
  const cs = res.lookup(N("ColorSpace"));
  check("CMYK: drawn through a default colour space under sRGB", cs instanceof PDFDict && cs.lookup(N("DefaultCMYK")) instanceof PDFArray);
  const g = (res.lookup(N("ExtGState")) as PDFDict).lookup(N("G1")) as PDFDict;
  check("transparency kept, unknown blend mode made Normal", g.lookup(N("BM")) === N("Normal") && (g.lookup(N("ca")) as PDFNumber).asNumber() === 0.8);
  check("turned page stays turned", i.doc.getPage(1).getRotation().angle === 90);
}

// --- Forms, comments, links and scripts ----------------------------------------------------
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  const name = form.createTextField("name");
  name.setText("Lindiwe Dube");
  name.addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 50, y: 650, width: 18, height: 18 });
  agree.check();
  const ctx = doc.context;
  // A ZapfDingbats check, as many form tools draw it.
  const zadb = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "ZapfDingbats" }));
  const on = ctx.register(ctx.flateStream("q BT 0 g /ZaDb 14 Tf 2 3 Td (4) Tj ET Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 18, 18], Resources: { Font: { ZaDb: zadb } } }));
  agree.acroField.getWidgets()[0].dict.set(N("AP"), ctx.obj({ N: { Yes: on, Off: ctx.register(ctx.flateStream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 18, 18] })) }, D: { Yes: on } }));
  const js = ctx.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hi')") });
  const highlight = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [50, 590, 250, 610], QuadPoints: [50, 610, 250, 610, 50, 590, 250, 590], C: [1, 1, 0], CA: 0.5, F: 4 }));
  const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [300, 590, 320, 610], Contents: PDFString.of("Check this"), C: [1, 0.8, 0] }));
  const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [50, 540, 250, 560], A: { S: "URI", URI: PDFString.of("https://example.org") }, Border: [0, 0, 0] }));
  const badLink = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [50, 500, 250, 520], A: js }));
  const movie = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Movie", Rect: [300, 300, 400, 400] }));
  const hidden = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [300, 200, 400, 250], F: 2, C: [1, 0, 0] }));
  const annots = page.node.lookup(N("Annots")) as PDFArray;
  for (const a of [highlight, note, link, badLink, movie, hidden]) annots.push(a);
  doc.catalog.set(N("OpenAction"), ctx.obj({ S: "JavaScript", JS: PDFString.of("this.print()") }));
  doc.catalog.set(N("Names"), ctx.obj({ JavaScript: { Names: [PDFString.of("init"), ctx.obj({ S: "JavaScript", JS: PDFString.of("1") })] } }));
  page.node.set(N("AA"), ctx.obj({ O: js }));
  page.drawText("Words on the form page", { x: 50, y: 760, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  const input = await doc.save();
  const result = await convert(input);
  const { after, i } = await common("forms and comments", input, result);
  check("forms: flattened, form gone, field value still reads", !i.acroForm && result.facts.fields === 2 && after.text[0].includes("Lindiwe Dube"), after.text);
  check("forms: the ZapfDingbats checkbox didn't make the page a picture", result.facts.pictures.length === 0, result.facts.pictures);
  const left = (i.doc.getPage(0).node.lookup(N("Annots")) as PDFArray).asArray().map((r) => i.doc.context.lookup(r) as PDFDict);
  const kinds = left.map((a) => (a.lookup(N("Subtype")) as PDFName).decodeText()).sort();
  check("comments: highlight, note and the web link stay; movie, hidden square and the script link go", kinds.join() === "Highlight,Link,Text", kinds);
  check("comments: each printed, each with only a normal appearance", left.every((a) => ((a.lookup(N("F")) as PDFNumber).asNumber() & 4) === 4) && left.filter((a) => a.lookup(N("Subtype")) !== N("Link")).every((a) => (a.lookup(N("AP")) as PDFDict).keys().length === 1));
  check("scripts: open action, document script and page action removed, and counted", result.facts.objects.scripts >= 3 && !i.doc.getPage(0).node.has(N("AA")), result.facts.objects);
}

// --- Attachments: removed in 2b, kept in 3b -----------------------------------------------
{
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText("Invoice with its data", { x: 20, y: 150, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  await doc.attach(new TextEncoder().encode("<invoice/>"), "invoice.xml", { mimeType: "application/xml", description: "Data" });
  const input = await doc.save();
  const two = await convert(input, { part: 2 });
  const r2 = await common("attachment", input, two, 2);
  check("2b: the attachment is gone, and the report says 3b keeps it", r2.i.ef === 0 && r2.after.attachments === 0 && pdfaLines(two).some((l) => l.text.includes("PDF/A-3b keeps attached files")));
  const three = await convert(input, { part: 3 });
  const r3 = await common("attachment", input, three, 3);
  const fs = [...r3.i.doc.context.enumerateIndirectObjects()].map(([, o]) => o).find((o) => o instanceof PDFDict && o.has(N("EF"))) as PDFDict | undefined;
  const af = r3.i.doc.catalog.lookup(N("AF"));
  check("3b: the attachment stays, with its relationship, both names and its type, listed in AF", r3.after.attachments === 1 && !!fs && fs.has(N("AFRelationship")) && fs.has(N("UF")) && af instanceof PDFArray && af.size() === 1);
}

// --- Passwords ---------------------------------------------------------------------------
{
  const doc = await SecurePDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.drawText("Locked words", { x: 30, y: 150, size: 14 });
  doc.encrypt({ userPassword: "", ownerPassword: "owner-only", permissions: { printing: false, copying: false } });
  const owner = await doc.save({ useObjectStreams: false });
  const result = await convert(owner);
  const { after } = await common("owner password", owner, result);
  check("owner password: opened without asking, decrypted, text reads", result.facts.encrypted === "restricted" && after.text[0].includes("Locked words"));

  const doc2 = await SecurePDFDocument.create();
  doc2.addPage([400, 300]).drawText("Secret words", { x: 30, y: 150, size: 14 });
  doc2.encrypt({ userPassword: "open-sesame", ownerPassword: "owner" });
  const user = await doc2.save({ useObjectStreams: false });
  const none = await settle(convert(user));
  check("user password: asks for it plainly", none.error instanceof PasswordError && none.error.message === NEEDS_PASSWORD, none.error?.message);
  const wrong = await settle(convert(user, { password: "nope" }));
  check("user password: a wrong one is said so", wrong.error?.message === WRONG_PASSWORD, wrong.error?.message);
  const right = await convert(user, { password: "open-sesame" });
  const r = await common("user password", user, right, 2, { password: "open-sesame" });
  check("user password: converted with it, the report says the password went", r.after.text[0].includes("Secret words") && pdfaLines(right).some((l) => l.text.includes("password")));
}

// --- Things only a picture can fix: a font with no free stand-in, an LZW stream, unknown operators ---
{
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const wingdings = ctx.register(
    ctx.obj({
      Type: "Font", Subtype: "TrueType", BaseFont: "Wingdings-Regular", FirstChar: 32, LastChar: 126, Widths: Array(95).fill(1000),
      FontDescriptor: { Type: "FontDescriptor", FontName: "Wingdings-Regular", Flags: 4, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 },
    })
  );
  const helv = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  rawPage(doc, [612, 792], "BT /W 20 Tf 72 700 Td (JKL) Tj ET BT /F 12 Tf 72 650 Td (Symbols page words) Tj ET", { Font: { W: wingdings, F: helv } });
  // Operators PDF doesn't define (inside BX/EX, as old tools wrote them): cut out.
  rawPage(doc, [612, 792], "BX 1 2 frobnicate EX BT /F 12 Tf 72 700 Td (Plain page words) Tj ET", { Font: { F: helv } });
  // An LZW-compressed page: re-encoded as Flate.
  const lzwPage = doc.addPage([300, 300]);
  lzwPage.node.set(N("Resources"), ctx.obj({ Font: { F: helv } }));
  lzwPage.node.set(N("Contents"), ctx.register(ctx.stream(lzw("BT /F 12 Tf 20 150 Td (LZW page words) Tj ET"), { Filter: "LZWDecode" })));
  const input = await doc.save();
  const result = await convert(input);
  const { after } = await common("fallbacks", input, result);
  check("Wingdings: its page becomes a picture, named in the report", result.facts.pictures.length === 1 && result.facts.pictures[0].page === 0 && pdfaLines(result).some((l) => l.text.includes("Rebuilt as pictures: page 1") && l.text.includes("Wingdings")), result.facts.pictures);
  check("Wingdings page: its other words can still be searched", after.text[0].includes("Symbols page words"), after.text[0]);
  check("unknown operators cut, LZW re-encoded, their pages read", result.facts.cuts >= 1 && result.facts.objects.lzw === 1 && after.text[1].includes("Plain page words") && after.text[2].includes("LZW page words"), { cuts: result.facts.cuts, lzw: result.facts.objects.lzw, text: after.text });
}

/** LZW encoding (PDF 32000-1, 7.4.4), early change on: 9-bit codes to start. */
function lzw(text: string): Uint8Array {
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  let next = 258;
  let width = 9;
  const bits: number[] = [];
  const emit = (code: number) => {
    for (let b = width - 1; b >= 0; b--) bits.push((code >> b) & 1);
  };
  emit(256);
  let w = "";
  for (const c of text) {
    if (dict.has(w + c)) w += c;
    else {
      emit(dict.get(w)!);
      dict.set(w + c, next++);
      if (next + 1 > 1 << width) width++;
      w = c;
    }
  }
  if (w) emit(dict.get(w)!);
  emit(257);
  while (bits.length % 8) bits.push(0);
  return Uint8Array.from({ length: bits.length / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
}

// --- A broken file --------------------------------------------------------------------------
{
  const broken = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >>\nthis is not a pdf at all");
  const r = await settle(convert(broken));
  check("broken file: refused with a message for people", !!r.error && !/PDFDocument|parse|offset/i.test(r.error.message), r.error?.message);
}

// --- Registered as a tool -----------------------------------------------------------------
{
  const { TOOLS, getTool, relatedTools } = await import("../lib/tools.tsx");
  const { filterTools } = await import("../components/tool-filter.ts");
  const { panelSpec } = await import("../components/tools/panel-spec.tsx");
  const { PROCESSORS } = await import("../components/tools/processors.ts");
  const sitemap = (await import("../app/sitemap.ts")).default;
  const tool = getTool("pdf-to-pdfa");
  check("registered once, under Convert, as a workbench tool that can be cancelled", !!tool && tool.category === "convert" && TOOLS.filter((t) => t.slug === "pdf-to-pdfa").length === 1 && panelSpec(tool).kind === "workbench" && !!PROCESSORS["pdf-to-pdfa"]?.cancellable);
  check("search finds it by what people type", ["PDF/A", "pdfa", "PDF/A-2b", "archive pdf", "archival"].every((q) => filterTools(TOOLS, "all", q)[0]?.slug === "pdf-to-pdfa"), ["PDF/A", "archive pdf", "PDF/A-2b"].map((q) => filterTools(TOOLS, "all", q).slice(0, 3).map((t) => t.slug)));
  check("other searches are as they were", filterTools(TOOLS, "all", "pdf to jpg")[0]?.slug === "pdf-to-jpg" && filterTools(TOOLS, "all", "a4")[0]?.slug === "resize-pdf");
  check("in the sitemap", sitemap().some((u) => u.url.endsWith("/tools/pdf-to-pdfa")));
  check("more tools offer the next steps", relatedTools("pdf-to-pdfa").map((t) => t.slug).includes("compress-pdf"));
  const fields = PROCESSORS["pdf-to-pdfa"].fields;
  check("options: PDF/A-2b first, 3b offered, a password field", fields[0].default === "2" && fields[0].options!.map((o) => o.value).join() === "2,3" && fields.some((f) => f.type === "password"));
}

if (OUT) writeFileSync(`${OUT}/list.txt`, saved.join("\n"));
console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
