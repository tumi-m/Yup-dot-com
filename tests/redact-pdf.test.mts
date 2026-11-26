// Redact PDF: the presets and their checks (Luhn, South African ID numbers,
// IBANs, dates), search with its options, where marks land, and the files it
// writes, opened again with pdf.js and pdf-lib as independent readers: the
// marked text gone from the page's text, from every decoded stream and
// string (hex and UTF-16 too, object streams too) and from bookmarks and
// details, the marks black when drawn, the rest still searchable and pages
// without marks untouched. Hard inputs: text split across TJ arrays with
// kerning, Type3 and CID fonts, text in form XObjects and in comments'
// appearances, invisible OCR text, a picture of text under a box, turned
// pages, mixed sizes and offset boxes, copies elsewhere in the document,
// metadata, bookmarks, scripts and attachments, forms and links, owner-
// password and locked files, broken files, a long document, and Cancel.
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
  type PDFPage,
} from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const marks = await import("../lib/pdf/redact/marks.ts");
const { redactPdf } = await import("../lib/pdf/redact/index.ts");
const { redactFile } = await import("../lib/pdf/redact/off-thread.ts");
const { findLeaks, stringsIn } = await import("../lib/pdf/redact/scan.ts");
const { redactDocument, readText, placeExactly, openWide, RedactionLeakError } = await import("../lib/pdf/redact/run.ts");
const { growToInk } = await import("../lib/pdf/redact/pictures.ts");
const { verifyRedaction } = await import("../lib/pdf/redact/verify.ts");
const { loadForRender } = await import("../lib/pdf/render.ts");
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
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

// pdf.js prints a line for every glyph it has no font for; the checks are what matter here.
const warn = console.log;
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("Warning:")) return;
  warn(...args);
};

// Pictures need a canvas and the JPEG encoder, as in a browser.
const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});
const canvasMod = await import("canvas");
(globalThis as Record<string, unknown>).document = {
  createElement: () => Object.assign(canvasMod.createCanvas(1, 1), { style: {} }),
};
const canvas = () => Object.assign(canvasMod.createCanvas(1, 1), { style: {} }) as unknown as HTMLCanvasElement;
const FONTS = "./node_modules/pdfjs-dist/standard_fonts/";

type Rect = import("../lib/pdf/redact/marks.ts").Rect;
type Mark = import("../lib/pdf/redact/marks.ts").Mark;

/** Each page's text as a reader gets it, and what its comments and fields say. */
async function readAll(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: FONTS }).promise;
  const pages: { text: string; width: number; height: number; rotate: number; notes: string[]; items: { str: string; x: number; y: number }[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((it): it is typeof it & { str: string; transform: number[] } => "str" in it && it.str.trim() !== "")
      .map((it) => {
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        return { str: it.str, x: t[4], y: t[5] };
      });
    const notes = (await page.getAnnotations()).flatMap((a: Record<string, unknown>) =>
      [(a.contentsObj as { str?: string })?.str, a.fieldValue, a.url, ...((a.textContent as string[]) ?? [])].filter((s): s is string => typeof s === "string" && !!s)
    );
    pages.push({ text: items.map((i) => i.str).join(" "), width: vp.width, height: vp.height, rotate: page.rotate, notes, items });
  }
  const outline = ((await doc.getOutline()) ?? []).map((o) => o.title);
  const meta = await doc.getMetadata();
  const attachments = await doc.getAttachments();
  const scripts = await doc.getJSActions();
  await doc.destroy();
  return { pages, outline, meta, attachments, scripts };
}

/** Every stream in the file decoded, and every string, as text: what someone digging in the file would find. */
async function rawText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let all = Buffer.from(bytes).toString("latin1") + "\n";
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
  return all.toLowerCase().replace(/\s+/g, "");
}
const gone = (raw: string, word: string) => !raw.includes(word.toLowerCase().replace(/\s+/g, ""));

/** The text runs of every page of `bytes`, as Redact PDF reads them. */
async function textOf(bytes: Uint8Array) {
  const loaded = await loadForRender(bytes);
  try {
    return { loaded, pages: await readText(loaded) };
  } catch (e) {
    loaded.destroy();
    throw e;
  }
}

/** Marks from a search over every page. */
function search(pages: Map<number, import("../lib/pdf/redact/marks.ts").PageText>, query: string, opts: import("../lib/pdf/redact/marks.ts").SearchOptions = {}): Mark[] {
  const pattern = marks.queryPattern(query, opts)!;
  const out: Mark[] = [];
  for (const [page, text] of pages) out.push(...marks.addFound(out, page, marks.findOnPage(text, pattern), "search", !!opts.wholeWord));
  return out;
}
function preset(pages: Map<number, import("../lib/pdf/redact/marks.ts").PageText>, id: import("../lib/pdf/redact/marks.ts").PresetId): Mark[] {
  const p = marks.presetById(id);
  const out: Mark[] = [];
  for (const [page, text] of pages) out.push(...marks.addFound(out, page, marks.findOnPage(text, p.pattern, p.valid), id, true));
  return out;
}
const box = (page: number, r: Rect): Mark => ({ id: marks.markId(), page, rects: [r], kind: "box", text: "", whole: true, on: true });

/** Redacts with the whole pipeline (pictures, worker writing, the check after), as the page does. */
async function redact(bytes: Uint8Array, list: Mark[], opts: { keepText?: boolean; dpi?: number; leave?: boolean } = {}) {
  const { loaded, pages } = await textOf(bytes);
  try {
    const plan = marks.planNeedles(pages, list);
    // Copies left unmarked are allowed only when asked: otherwise the check must find them.
    if (!opts.leave) for (const n of plan.needles) n.allowed = {};
    const done = await settle(
      redactDocument(new Blob([bytes as Uint8Array<ArrayBuffer>]), { marks: list, needles: plan.needles, dpi: opts.dpi ?? 100, keepText: opts.keepText ?? true }, { loaded, canvas })
    );
    return { ...done, plan };
  } finally {
    loaded.destroy();
  }
}

/** Mean brightness (0 black, 255 white) of an area of a page as drawn. */
async function brightness(bytes: Uint8Array, page: number, r: Rect): Promise<number> {
  const loaded = await loadForRender(bytes);
  try {
    const c = canvas();
    await loaded.renderPage(page + 1, c, 2, { pixelRatio: 1, forms: true });
    const s = c.width / (await loaded.getPageViewport(page + 1, 1)).width;
    const ctx = c.getContext("2d")!;
    const x = Math.ceil(r.x0 * s + 2);
    const y = Math.ceil(r.y0 * s + 2);
    const { data } = ctx.getImageData(x, y, Math.max(1, Math.floor(r.x1 * s - 2) - x), Math.max(1, Math.floor(r.y1 * s - 2) - y));
    let sum = 0;
    for (let p = 0; p < data.length; p += 4) sum += (data[p] + data[p + 1] + data[p + 2]) / 3;
    return sum / (data.length / 4);
  } finally {
    loaded.destroy();
  }
}

// --- Presets and their checks ---------------------------------------------------
{
  check("Luhn: a test card passes, one digit off fails", marks.luhn("4111 1111 1111 1111") && !marks.luhn("4111 1111 1111 1112"));
  check("card numbers: 13 to 19 Luhn digits, not all the same", marks.cardNumber("4111-1111-1111-1111") && marks.cardNumber("378282246310005") && marks.cardNumber("4222222222222") && !marks.cardNumber("0000000000000000") && !marks.cardNumber("1234 5678 9012 3456"));
  check("card numbers start as cards do: an ID number with a check digit isn't one", !marks.cardNumber("8001015009087") && !marks.cardNumber("7992739871300"));
  check("SA ID: a real birth date, citizenship 0/1/2 and the Luhn digit", marks.saIdNumber("8001015009087") && marks.saIdNumber("800101 5009 087") && !marks.saIdNumber("8001015009088") && !marks.saIdNumber("8013015009087"));
  check("SA ID: 29 February only in a leap year", marks.saIdNumber("0002295009084") === marks.luhn("0002295009084") && !marks.saIdNumber("0102295009083"));
  check("IBAN: the check digits must be right", marks.iban("GB82 WEST 1234 5698 7654 32") && !marks.iban("GB82 WEST 1234 5698 7654 33"));
  check("phone numbers: +27, 0…, (011) and 555-123-4567 forms", ["+27 82 123 4567", "082 123 4567", "(011) 123-4567", "555-123-4567", "0821234567"].every(marks.phoneNumber));
  check("phone numbers: plain amounts and dates aren't", !marks.phoneNumber("123456789") && !marks.phoneNumber("2024-03-12") && !marks.phoneNumber("12 345"));
  check("dates: day and month in range, either order", ["12/03/2024", "2024-03-12", "03/31/2024", "12 March 2024", "March 12, 2024", "1st of Jan 2020", "31.12.99"].every(marks.dateText));
  check("dates: impossible ones aren't", !marks.dateText("32/01/2024") && !marks.dateText("2023-02-29") && !marks.dateText("13/13/2024"));

  const page: import("../lib/pdf/redact/marks.ts").PageText = {
    runs: [
      { str: "Mail jane.doe@example.co.za or call +27 82 123 4567 today.", rect: { x0: 0, y0: 0, x1: 400, y1: 12 }, flow: "right", eol: true },
      { str: "Card 4111 1111 1111 1111, ID 8001015009087, acc 62012345678.", rect: { x0: 0, y0: 20, x1: 400, y1: 32 }, flow: "right", eol: true },
      { str: "Signed 12 March 2024; ref 1234567890123 is no ID.", rect: { x0: 0, y0: 40, x1: 400, y1: 52 }, flow: "right", eol: true },
    ],
    notes: [{ text: "Reach me at agent@spy.org", rect: { x0: 300, y0: 300, x1: 320, y1: 320 } }],
  };
  const all = (id: Parameters<typeof marks.presetById>[0]) => marks.findOnPage(page, marks.presetById(id).pattern, marks.presetById(id).valid).map((f) => f.text);
  check("emails, in the text and in a comment", all("email").join() === "jane.doe@example.co.za,agent@spy.org", all("email"));
  check("phone numbers", all("phone").join() === "+27 82 123 4567", all("phone"));
  check("card numbers (Luhn-checked)", all("card").join() === "4111 1111 1111 1111", all("card"));
  check("SA ID numbers, and a 13-digit number that isn't one is left", all("id").join() === "8001015009087", all("id"));
  check("account-like numbers, not a phone number's digits", all("account").join() === "62012345678,1234567890123", all("account"));
  const phones = marks.addFound([], 0, marks.findOnPage(page, marks.presetById("phone").pattern, marks.presetById("phone").valid), "phone", true);
  const inside = marks.addFound(phones, 0, [{ text: "82 123", rects: [marks.grow(phones[0].rects[0], -3, -1)] }], "account", true);
  check("a find inside a mark already there isn't marked again", phones.length === 1 && inside.length === 0);
  check("dates", all("date").join() === "12 March 2024", all("date"));
  const comment = marks.findOnPage(page, marks.presetById("email").pattern)[1];
  check("a match in a comment marks the comment", JSON.stringify(comment.rects) === JSON.stringify([page.notes[0].rect]));
}

// --- Search and where marks land ---------------------------------------------------
{
  const run = { str: "Jane Doe and JANE and Janet", rect: { x0: 100, y0: 50, x1: 300, y1: 62 }, flow: "right" as const, eol: true };
  const page = { runs: [run], notes: [] };
  const found = (q: string, o = {}) => marks.findOnPage(page, marks.queryPattern(q, o)!).map((f) => f.text);
  check("search ignores case by default", found("jane").join() === "Jane,JANE,Jane", found("jane"));
  check("match case", found("jane", { matchCase: true }).length === 0 && found("Jane", { matchCase: true }).length === 2);
  check("whole words leave Janet", found("jane", { wholeWord: true }).join() === "Jane,JANE");
  check("a space in the search matches text split oddly", marks.findOnPage({ runs: [{ ...run, str: "JaneDoe" }], notes: [] }, marks.queryPattern("Jane Doe")!).length === 1);
  check("an empty search finds nothing", marks.queryPattern("   ") === null);
  check("characters with a meaning in patterns are plain", found("(c)").length === 0 && marks.findOnPage({ runs: [{ ...run, str: "a (c) b" }], notes: [] }, marks.queryPattern("(c)")!).length === 1);
  const [doe] = marks.findOnPage(page, marks.queryPattern("Doe")!);
  const r = doe.rects[0];
  // "Jane " is about a fifth of the run: the box starts there and covers "Doe" with a little room.
  check("a match is boxed where it sits in its run", r.x0 > 120 && r.x0 < 138 && r.x1 > 150 && r.x1 < 168 && r.y0 <= 50 && r.y1 >= 62, r);
  const turned = marks.findOnPage({ runs: [{ ...run, flow: "down", rect: { x0: 50, y0: 100, x1: 62, y1: 300 } }], notes: [] }, marks.queryPattern("Doe")!)[0].rects[0];
  check("in text running down the page, the box runs down too", turned.x0 <= 50 && turned.x1 >= 62 && turned.y0 > 120 && turned.y1 < 168, turned);
  const rtl = marks.findOnPage({ runs: [{ ...run, flow: "left" }], notes: [] }, marks.queryPattern("Jane Doe")!)[0].rects[0];
  check("right-to-left text is boxed from the right", rtl.x1 >= 299 && rtl.x0 > 200, rtl);
  const two = marks.findOnPage(
    { runs: [{ str: "Jane", rect: { x0: 0, y0: 0, x1: 30, y1: 12 }, flow: "right", eol: true }, { str: "Doe", rect: { x0: 0, y0: 20, x1: 25, y1: 32 }, flow: "right", eol: true }], notes: [] },
    marks.queryPattern("Jane Doe")!
  );
  check("a match over two lines gets a box on each", two.length === 1 && two[0].rects.length === 2, two);
  const listed = marks.addFound([], 0, [{ text: "x", rects: [r] }, { text: "x", rects: [r] }], "search", false);
  check("the same place isn't marked twice", listed.length === 1);
  check("words under a box", marks.wordsUnder(page, [{ x0: 95, y0: 45, x1: 165, y1: 65 }]) === "Jane Doe");
  check("words well clear of a box stay; the one next to it goes too", marks.wordsClear(page, [{ x0: 95, y0: 45, x1: 165, y1: 65 }]).map((w) => w.text).join(" ") === "JANE and Janet");
  check("the file name", marks.redactedName("Contract.PDF") === "Contract-redacted.pdf" && marks.redactedName(".pdf") === "document-redacted.pdf");
  const moved = marks.dragRect({ x0: 10, y0: 10, x1: 50, y1: 30 }, "move", 1000, 0, 200, 100);
  check("a box moved off the page stops at the edge", moved.x1 === 200 && moved.x0 === 160);
  check("a box can't shrink to nothing", marks.dragRect({ x0: 10, y0: 10, x1: 50, y1: 30 }, "se", -100, -100, 200, 100).x1 === 10 + marks.MIN_BOX);
  const key = (k: string, m: { altKey?: boolean; shiftKey?: boolean } = {}) => ({ key: k, altKey: false, shiftKey: false, ...m });
  check("arrows move a box, Shift 10, Alt resizes", marks.nudgeRect({ x0: 10, y0: 10, x1: 50, y1: 30 }, key("ArrowRight"), 200, 100)?.x0 === 11 && marks.nudgeRect({ x0: 10, y0: 10, x1: 50, y1: 30 }, key("ArrowDown", { shiftKey: true }), 200, 100)?.y0 === 20 && marks.nudgeRect({ x0: 10, y0: 10, x1: 50, y1: 30 }, key("ArrowRight", { altKey: true }), 200, 100)?.x1 === 51 && marks.nudgeRect({ x0: 10, y0: 10, x1: 50, y1: 30 }, key("a"), 200, 100) === null);
}


// --- Files: fixtures ---------------------------------------------------------------

/** A page whose content stream is `ops`, with Helvetica as /F1 and any other resources given. */
function rawPage(doc: PDFDocument, size: [number, number], ops: string, resources: Record<string, unknown> = {}, helv?: import("pdf-lib").PDFRef) {
  const page = doc.addPage(size);
  const { context } = doc;
  const font = helv ?? context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const fonts = { F1: font, ...((resources.Font as object) ?? {}) };
  page.node.set(PDFName.of("Resources"), context.obj({ ...resources, Font: fonts }));
  page.node.set(PDFName.of("Contents"), context.register(context.flateStream(ops)));
  return page;
}

/** Where a found string sits, as marks, on one page of `bytes`. */
async function marksFor(bytes: Uint8Array, query: string, opts: import("../lib/pdf/redact/marks.ts").SearchOptions = {}) {
  const { loaded, pages } = await textOf(bytes);
  loaded.destroy();
  return { pages, list: search(pages, query, opts) };
}

const helvetica = async (doc: PDFDocument) => doc.embedFont(StandardFonts.Helvetica);

// --- Files: a plain search, and pages without marks left alone ----------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Invoice for page ${i + 1}`, { x: 72, y: 760, size: 14, font });
    if (i === 0) page.drawText("Client: Jane Doe, 12 Main Road", { x: 72, y: 700, size: 12, font });
  }
  const bytes = await doc.save();
  const { list } = await marksFor(bytes, "Jane Doe");
  check("search marks the name on page 1 only", list.length === 1 && list[0].page === 0, list);
  const done = await redact(bytes, list);
  check("a plain search redacts", !!done.value && !done.error, done.error?.message);
  if (done.value) {
    const out = done.value.bytes;
    const r = await readAll(out);
    const raw = await rawText(out);
    check("the name is gone from the page's text", !/jane|doe/i.test(r.pages[0].text), r.pages[0].text);
    // Words right next to a mark go too, as where each word sits is estimated.
    check("the rest of the page is still searchable", /Invoice for page 1/.test(r.pages[0].text) && /Main Road/.test(r.pages[0].text), r.pages[0].text);
    check("the name is gone from every stream and string", gone(raw, "Jane Doe") && gone(raw, "JaneDoe"));
    check("pages and sizes stay", r.pages.length === 3 && r.pages.every((p) => near(p.width, 595) && near(p.height, 842)));
    const rect = list[0].rects[0];
    check("the mark is black when drawn", (await brightness(out, 0, rect)) < 40);
    check("the report counts one page and one area", done.value.report.pages === 1 && done.value.report.areas === 1, done.value.report);
    const before = await PDFDocument.load(bytes);
    const after = await PDFDocument.load(out);
    const content = (d: PDFDocument, i: number) => {
      const c = d.getPages()[i].node.lookup(PDFName.of("Contents"));
      return c instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(c).decode()).toString("latin1") : "";
    };
    check("pages without marks keep their own content", content(before, 1) === content(after, 1) && content(before, 2) === content(after, 2));
    check("a page without marks still has its text as text", r.pages[1].text === "Invoice for page 2");
    const images = [...after.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
    check("only the marked page became a picture", images.length === 1, images.length);
  }
  const noText = await redact(bytes, list, { keepText: false });
  const r2 = noText.value ? await readAll(noText.value.bytes) : null;
  check("without keeping text, the rebuilt page has none", !!r2 && r2.pages[0].text === "" && r2.pages[1].text === "Invoice for page 2", noText.error?.message);
  const none = await settle(redactDocument(new Blob([bytes as Uint8Array<ArrayBuffer>]), { marks: [], needles: [], dpi: 100, keepText: true }, { canvas }));
  check("nothing marked: says to mark something", none.error?.message === "Mark something to redact first.", none.error?.message);
}

// --- Files: text split across TJ arrays, kerning and hex strings ----------------------
{
  const doc = await PDFDocument.create();
  rawPage(
    doc,
    [612, 792],
    [
      "BT /F1 12 Tf 72 700 Td [(Acc) -20 (ount: Se) 35 (cr) -12 (et) 8 (Code) 40 (99)] TJ ET",
      "BT /F1 12 Tf 72 660 Td <5265663a2048657853656372657421> Tj ET",
      "BT /F1 12 Tf 72 620 Td (Pass) Tj 4 0 Td (word: Fish) Tj ET",
      "BT /F1 12 Tf 72 580 Td (Keep this line) Tj ET",
    ].join("\n")
  );
  const bytes = await doc.save();
  const { pages } = await textOf(bytes);
  const list = [...search(pages, "SecretCode99"), ...search(pages, "HexSecret"), ...search(pages, "word: Fish")];
  check("search finds text split over TJ pieces, a hex string and two Tj", list.length === 3, list.map((m) => m.text));
  const done = await redact(bytes, list);
  check("TJ and hex: redacted", !!done.value, done.error?.message);
  if (done.value) {
    const raw = await rawText(done.value.bytes);
    const r = await readAll(done.value.bytes);
    check("TJ and hex: gone from the file, even with the pieces joined", ["SecretCode99", "Secret", "HexSecret", "Fish"].every((w) => gone(raw, w)), r.pages[0].text);
    check("TJ and hex: the line left alone is still text", /Keep this line/.test(r.pages[0].text));
  }
}

// --- Files: Type3 and CID fonts -----------------------------------------------------
{
  const doc = await PDFDocument.create();
  const { context } = doc;
  // A Type3 font whose glyphs are boxes; codes A-E show S, E, C, R, T by their glyph names.
  const glyph = (w: number) => context.register(context.flateStream(`${w} 0 0 0 ${w} 700 d1 50 0 ${w - 100} 700 re f`));
  const names = ["S", "E", "C", "R", "T"];
  const type3 = context.register(
    context.obj({
      Type: "Font",
      Subtype: "Type3",
      FontBBox: [0, 0, 600, 700],
      FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: Object.fromEntries(names.map((n) => [n, glyph(600)])),
      Encoding: { Type: "Encoding", Differences: [65, ...names.map((n) => PDFName.of(n))] },
      FirstChar: 65,
      LastChar: 69,
      Widths: [600, 600, 600, 600, 600],
      Resources: {},
    })
  );
  rawPage(doc, [612, 792], "BT /T3 20 Tf 72 700 Td (ABCDBE) Tj ET\nBT /F1 12 Tf 72 600 Td (Type3 page) Tj ET", { Font: { T3: type3 } });
  doc.registerFontkit(fontkit);
  const cid = await doc.embedFont(readFileSync(FONTS + "LiberationSans-Regular.ttf"), { subset: true });
  const page = doc.addPage([612, 792]);
  page.drawText("Card 4111 1111 1111 1111 on file", { x: 72, y: 700, size: 12, font: cid });
  page.drawText("Account 62012345678", { x: 72, y: 660, size: 12, font: cid });
  page.drawText("Nothing else", { x: 72, y: 620, size: 12, font: cid });
  const bytes = await doc.save();
  const { pages } = await textOf(bytes);
  check("pdf.js reads the Type3 text by its glyph names", pageStringOf(pages.get(0)!).includes("SECRET"), pageStringOf(pages.get(0)!));
  const list = [...search(pages, "SECRET"), ...preset(pages, "card"), ...preset(pages, "account")];
  check("Type3 search and card and account presets on a CID font", list.length === 3 && list[0].page === 0 && list.filter((m) => m.page === 1).length === 2, list.map((m) => [m.page, m.text]));
  const done = await redact(bytes, list);
  check("Type3 and CID: redacted", !!done.value, done.error?.message);
  if (done.value) {
    const r = await readAll(done.value.bytes);
    const raw = await rawText(done.value.bytes);
    check("Type3: the word is gone, and so are its glyphs' codes", !/SECRET/.test(r.pages[0].text) && gone(raw, "ABCDBE"), r.pages[0].text);
    check("CID: the card and account numbers are gone", !/4111|62012345678/.test(r.pages[1].text) && gone(raw, "4111 1111 1111 1111") && gone(raw, "62012345678"), r.pages[1].text);
    check("CID: the words around them stay searchable", /file/.test(r.pages[1].text) && /Nothing else/.test(r.pages[1].text), r.pages[1].text);
    for (const m of list) check(`${m.kind}: black where it was`, (await brightness(done.value.bytes, m.page, m.rects[0])) < 40);
  }
}

function pageStringOf(p: import("../lib/pdf/redact/marks.ts").PageText) {
  return marks.pageString(p).text;
}

// --- Files: form XObjects, comments' appearances, invisible text and pictures of text -----
{
  const doc = await PDFDocument.create();
  const { context } = doc;
  const helv = context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const form = context.register(
    context.flateStream("BT /F1 12 Tf 0 0 Td (XObjectSecret inside a form) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, -5, 300, 15], Resources: { Font: { F1: helv } } })
  );
  // A comment drawn by its appearance, with the same text as its note, and a stamp with only an appearance.
  const ap = (text: string) =>
    context.register(context.flateStream(`BT /F1 10 Tf 2 4 Td (${text}) Tj ET`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 20], Resources: { Font: { F1: helv } } }));
  const freeText = context.register(context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [72, 500, 272, 520], Contents: PDFString.of("AppearanceSecret"), DA: PDFString.of("/F1 10 Tf"), AP: { N: ap("AppearanceSecret") } }));
  const stamp = context.register(context.obj({ Type: "Annot", Subtype: "Stamp", Rect: [72, 440, 272, 460], AP: { N: ap("StampSecret") } }));
  // A picture of words, with invisible OCR-style words over it.
  const pic = canvasMod.createCanvas(400, 100);
  const g = pic.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 400, 100);
  g.fillStyle = "#000";
  g.font = "40px sans-serif";
  g.fillText("PICTURE TEXT", 10, 65);
  const png = await doc.embedPng(pic.toBuffer("image/png"));
  const page = rawPage(
    doc,
    [612, 792],
    ["q 1 0 0 1 72 700 cm /X1 Do Q", "q 200 0 0 50 72 300 cm /Im1 Do Q", "BT 3 Tr /F1 30 Tf 80 312 Td (PICTURE TEXT) Tj ET", "BT /F1 12 Tf 72 200 Td (Visible words) Tj ET"].join("\n"),
    { XObject: { X1: form, Im1: png.ref } },
    helv
  );
  page.node.set(PDFName.of("Annots"), context.obj([freeText, stamp]));
  const bytes = await doc.save();
  const { pages } = await textOf(bytes);
  const picBox: Rect = { x0: 70, y0: 792 - 352, x1: 274, y1: 792 - 298 };
  const stampBox: Rect = { x0: 70, y0: 792 - 462, x1: 274, y1: 792 - 438 };
  const list = [...search(pages, "XObjectSecret"), ...search(pages, "AppearanceSecret"), box(0, picBox), box(0, stampBox)];
  check("search finds text in a form XObject and in a comment", list.filter((m) => m.kind === "search").length === 2, list.map((m) => m.text));
  const plan = marks.planNeedles(pages, list);
  check("a box over a picture with invisible words takes those words", plan.needles.some((n) => /PICTURE TEXT/.test(n.text)), plan.needles.map((n) => n.text));
  const done = await redact(bytes, list);
  check("XObjects, appearances, invisible text, pictures: redacted", !!done.value, done.error?.message);
  if (done.value) {
    const out = done.value.bytes;
    const r = await readAll(out);
    const raw = await rawText(out);
    check("text in a form XObject is gone", gone(raw, "XObjectSecret") && !/XObjectSecret/.test(r.pages[0].text));
    check("a comment's note and appearance are gone", gone(raw, "AppearanceSecret") && r.pages[0].notes.length === 0, r.pages[0].notes);
    check("a stamp with text only in its appearance is gone", gone(raw, "StampSecret"));
    check("invisible words over a picture are gone", gone(raw, "PICTURE TEXT") && !/PICTURE/.test(r.pages[0].text), r.pages[0].text);
    check("the picture of words is black under the box", (await brightness(out, 0, picBox)) < 40);
    check("the stamp is black under the box", (await brightness(out, 0, stampBox)) < 40);
    const after = await PDFDocument.load(out);
    const widths = [...after.context.enumerateIndirectObjects()]
      .filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
      .map(([, o]) => (o as PDFRawStream).dict.get(PDFName.of("Width"))?.toString());
    check("the original picture is no longer in the file", !widths.includes("400"), widths);
    check("words clear of the marks stay searchable", /Visible words/.test(r.pages[0].text), r.pages[0].text);
  }
}

// --- Files: turned pages, boxes that don't start at 0,0, and mixed sizes ----------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const specs: { size: [number, number]; rotate: number; media?: [number, number, number, number] }[] = [
    { size: [400, 600], rotate: 90, media: [50, 50, 450, 650] },
    { size: [842, 595], rotate: 0 },
    { size: [300, 300], rotate: 180 },
    { size: [612, 792], rotate: 270 },
  ];
  for (const [i, s] of specs.entries()) {
    const page = doc.addPage(s.size);
    if (s.media) page.setMediaBox(...s.media);
    const x = (s.media?.[0] ?? 0) + 30;
    const y = (s.media?.[1] ?? 0) + 100;
    page.drawText(`Turned secret ${i + 1}`, { x, y, size: 12, font });
    page.drawText(`Stays ${i + 1}`, { x, y: y + 40, size: 12, font });
    page.setRotation(degrees(s.rotate));
  }
  const bytes = await doc.save();
  const { pages, loaded } = await textOf(bytes);
  loaded.destroy();
  const list = search(pages, "Turned secret");
  check("turned pages: one match on each", list.length === 4, list.map((m) => m.page));
  const done = await redact(bytes, list);
  check("turned pages: redacted", !!done.value, done.error?.message);
  if (done.value) {
    const before = await readAll(bytes);
    const r = await readAll(done.value.bytes);
    const raw = await rawText(done.value.bytes);
    check("turned pages: the words are gone", gone(raw, "Turned secret") && r.pages.every((p) => !/Turned/.test(p.text)), r.pages.map((p) => p.text));
    check("turned pages: each keeps its turn and size", r.pages.every((p, i) => p.rotate === before.pages[i].rotate && near(p.width, before.pages[i].width) && near(p.height, before.pages[i].height)), r.pages.map((p) => [p.rotate, p.width, p.height]));
    // The words kept are laid over the picture where the reader sees them.
    const words = (t: Map<number, import("../lib/pdf/redact/marks.ts").PageText>, i: number) => t.get(i)!.runs.flatMap(marks.wordsOf).find((w) => w.text === "Stays")!.rect;
    const now = await textOf(done.value.bytes);
    now.loaded.destroy();
    for (const i of r.pages.keys()) {
      const a = words(pages, i);
      const b = words(now.pages, i);
      const d = Math.hypot((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2, (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
      check(`turned page ${i + 1}: the words kept are where they were`, d < 6, { a, b });
      check(`turned page ${i + 1}: black where the mark was`, (await brightness(done.value.bytes, i, list[i].rects[0])) < 50);
    }
  }
}

// --- Files: copies elsewhere, shared XObjects, metadata and bookmarks ------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const { context } = doc;
  const helv = context.register(context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding" }));
  const shared = context.register(context.flateStream("BT /F1 12 Tf 0 0 Td (Shared Jane Doe) Tj ET", { Type: "XObject", Subtype: "Form", BBox: [0, -5, 300, 15], Resources: { Font: { F1: helv } } }));
  const p1 = rawPage(doc, [595, 842], "q 1 0 0 1 72 700 cm /X1 Do Q\nBT /F1 12 Tf 72 650 Td (Page one) Tj ET", { XObject: { X1: shared } }, helv);
  const p2 = rawPage(doc, [595, 842], "q 1 0 0 1 72 700 cm /X1 Do Q\nBT /F1 12 Tf 72 650 Td (Page two) Tj ET", { XObject: { X1: shared } }, helv);
  const p3 = doc.addPage([595, 842]);
  p3.drawText("Jane Doe signs here", { x: 72, y: 700, size: 12, font });
  doc.setTitle("Jane Doe contract");
  doc.setAuthor("Jane Doe");
  doc.setSubject("About Jane Doe");
  doc.setKeywords(["Jane Doe"]);
  const xmp = context.register(context.stream(`<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title>Jane Doe contract</dc:title></x:xmpmeta><?xpacket end="w"?>`, { Type: "Metadata", Subtype: "XML" }));
  doc.catalog.set(PDFName.of("Metadata"), xmp);
  // Bookmarks: one names her, one doesn't.
  const outlines = context.nextRef();
  const b1 = context.nextRef();
  const b2 = context.nextRef();
  context.assign(b1, context.obj({ Title: PDFHexString.fromText("Jane Doe's details"), Parent: outlines, Next: b2, Dest: [p1.ref, "Fit"] }));
  context.assign(b2, context.obj({ Title: PDFString.of("Introduction"), Parent: outlines, Prev: b1, Dest: [p2.ref, "Fit"] }));
  context.assign(outlines, context.obj({ Type: "Outlines", First: b1, Last: b2, Count: 2 }));
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  // A script, an attachment and a page thumbnail.
  const js = context.register(context.obj({ S: "JavaScript", JS: PDFString.of("app.alert('Jane Doe')") }));
  await doc.attach(new TextEncoder().encode("Jane Doe's ID: 8001015009087"), "notes.txt", { mimeType: "text/plain" });
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict) ?? context.obj({});
  doc.catalog.set(PDFName.of("Names"), names);
  names.set(PDFName.of("JavaScript"), context.obj({ Names: [PDFString.of("hello"), js] }));
  doc.catalog.set(PDFName.of("OpenAction"), js);
  p1.node.set(PDFName.of("Thumb"), context.register(context.flateStream("Jane Doe", { Width: 1, Height: 1, ColorSpace: "DeviceGray", BitsPerComponent: 8 })));
  const bytes = await doc.save();

  const { pages } = await textOf(bytes);
  const all = search(pages, "Jane Doe");
  check("copies: the name is found on all three pages", all.map((m) => m.page).join() === "0,1,2", all.map((m) => m.page));
  const firstOnly = all.filter((m) => m.page === 0);
  const plan = marks.planNeedles(pages, firstOnly);
  check("copies: marking one shows the copies on pages 2 and 3", plan.copies.map((c) => c.page).join() === "1,2", plan.copies);

  const strict = await redact(bytes, firstOnly);
  check("copies left unmarked stop the download, naming the page", strict.error instanceof RedactionLeakError && /Jane Doe/.test(strict.error.message) && /page 2|page 3/.test(strict.error.message), strict.error?.message);

  const left = await redact(bytes, firstOnly, { leave: true });
  check("copies left on purpose: redacted", !!left.value, left.error?.message);
  if (left.value) {
    const r = await readAll(left.value.bytes);
    check("copies left on purpose stay on their pages only", !/Jane/.test(r.pages[0].text) && /Shared Jane Doe/.test(r.pages[1].text) && /Jane Doe signs/.test(r.pages[2].text), r.pages.map((p) => p.text));
  }

  const every = await redact(bytes, all);
  check("every copy marked: redacted", !!every.value, every.error?.message);
  if (every.value) {
    const out = every.value.bytes;
    const r = await readAll(out);
    const raw = await rawText(out);
    check("every copy: gone from every page, stream and string", gone(raw, "Jane Doe") && r.pages.every((p) => !/Jane/.test(p.text)), r.pages.map((p) => p.text));
    check("the title and every detail are gone", !r.meta.info.Title && !r.meta.info.Author && !r.meta.info.Subject && !r.meta.info.Keywords && !r.meta.metadata, r.meta.info);
    check("the bookmark naming her is renamed, the other kept", r.outline.join("|") === "Redacted|Introduction", r.outline);
    check("scripts and attachments are gone", !r.attachments && !r.scripts && every.value.report.scripts > 0 && every.value.report.attachments > 0, { a: r.attachments, s: r.scripts });
    check("the ID number in the attachment is gone too", gone(raw, "8001015009087"));
    const after = await PDFDocument.load(out);
    check("thumbnails are gone", after.getPages().every((p) => !p.node.has(PDFName.of("Thumb"))));
    check("the bookmarks still go to their pages", r.outline.length === 2);
  }

  // Details go even when the marks hold nothing that's in them.
  const plainBox = await redact(bytes, [box(0, { x0: 60, y0: 180, x1: 200, y1: 200 })], { leave: true });
  const rb = plainBox.value ? await readAll(plainBox.value.bytes) : null;
  check("a box anywhere: details, scripts and attachments still go", !!rb && !rb.meta.info.Title && !rb.meta.metadata && !rb.attachments && !rb.scripts, plainBox.error?.message);
}

// --- Files: forms, links and other comments -----------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const form = doc.getForm();
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  p1.drawText("Name:", { x: 72, y: 705, size: 12, font });
  const name = form.createTextField("name");
  name.setText("Jane Doe");
  name.addToPage(p1, { x: 130, y: 700, width: 200, height: 20 });
  const city = form.createTextField("city");
  city.setText("Cape Town");
  city.addToPage(p2, { x: 130, y: 700, width: 200, height: 20 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(p1, { x: 72, y: 600, width: 14, height: 14 });
  agree.check();
  const { context } = doc;
  const link = (rect: number[], uri: string) => context.register(context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of(uri) } }));
  const linkFar = link([72, 100, 200, 120], "https://example.com/terms");
  const linkOver = link([128, 698, 332, 722], "https://example.com/profile");
  const linkNamed = link([72, 50, 200, 70], "mailto:jane.doe@example.com");
  const note = context.register(context.obj({ Type: "Annot", Subtype: "Text", Rect: [400, 400, 420, 420], Contents: PDFString.of("Call her back") }));
  p1.node.Annots()!.push(linkFar);
  p1.node.Annots()!.push(linkOver);
  p1.node.Annots()!.push(linkNamed);
  p1.node.Annots()!.push(note);
  form.updateFieldAppearances();
  const bytes = await doc.save();
  const { pages } = await textOf(bytes);
  const list = [...search(pages, "Jane Doe"), ...preset(pages, "email")];
  check("forms: the field's value and a link's address are found", list.length === 2 && list.every((m) => m.page === 0), list.map((m) => m.text));
  const done = await redact(bytes, list);
  check("forms and links: redacted", !!done.value, done.error?.message);
  if (done.value) {
    const out = done.value.bytes;
    const after = await PDFDocument.load(out);
    const fields = after.getForm().getFields().map((f) => f.getName());
    check("fields on the redacted page leave the form; others stay", fields.join() === "city", fields);
    check("the field left keeps its value", after.getForm().getTextField("city").getText() === "Cape Town");
    const r = await readAll(out);
    const raw = await rawText(out);
    check("the value and the address are gone from the file", gone(raw, "Jane Doe") && gone(raw, "jane.doe@example.com"));
    const urls = (await (async () => {
      const d = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
      const a = (await (await d.getPage(1)).getAnnotations()).map((x: Record<string, unknown>) => x.url);
      await d.destroy();
      return a;
    })()) as string[];
    check("a link clear of every mark stays; one over a mark goes", urls.join() === "https://example.com/terms", urls);
    check("the report counts the comments and fields taken off", done.value.report.annotations >= 5 && done.value.report.fields === 2, done.value.report);
    check("the page drawn keeps how the fields looked, outside the marks", /Name:/.test(r.pages[0].text));
  }
}

// --- The check after: what it finds -----------------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  const page = doc.addPage([595, 842]);
  page.drawText("Clean page", { x: 72, y: 700, size: 12, font });
  const { context } = doc;
  // Hidden in a dict (packed in an object stream when saved), in UTF-16, and in an object nothing uses.
  context.register(context.obj({ Note: PDFHexString.fromText("Jane Doe") }));
  doc.catalog.set(PDFName.of("Extra"), context.obj({ Who: PDFHexString.of("4a616e6520446f65") }));
  rawPage(doc, [595, 842], "BT /F1 12 Tf 72 700 Td [(Ja) -30 (ne D) 20 (oe)] TJ ET");
  const bytes = await doc.save({ useObjectStreams: true });
  const needle = { text: "Jane Doe", whole: true, allowed: {} };
  const leaks = await findLeaks(bytes, [needle]);
  const where = leaks.map((l) => l.where);
  check("the file search finds a hex string in an object stream", where.includes("in the document's settings"), where);
  check("…an object nothing uses", where.includes("in a part of the file no page uses"), where);
  check("…and text split across a TJ array on a page", where.includes("on page 2"), where);
  check("…but nothing on a clean page", !where.includes("on page 1"), where);
  check("copies left on purpose aren't leaks", !(await findLeaks(bytes, [{ ...needle, allowed: { 1: 1 } }])).some((l) => l.where === "on page 2"));
  check("strings in TJ arrays are joined as shown", stringsIn(new TextEncoder().encode("[(Ja) -30 (ne D) 20 (oe)] TJ (x) Tj")).includes("Jane Doe x"));

  const loaded = await loadForRender(bytes);
  const found = await verifyRedaction(loaded, { pageCount: 2, marked: [{ page: 1, rects: [{ x0: 60, y0: 120, x1: 200, y1: 150 }] }], needles: [needle] }, { canvas });
  loaded.destroy();
  const said = found.map((l) => l.where);
  check("the reader check finds text still on a page, under a box, and a box that isn't black", said.includes("on page 2") && said.includes("under a box on page 2") && said.includes("A box on page 2 didn't come out black"), said);
  check("the message says nothing was saved", /nothing was saved/.test(new RedactionLeakError(found).message) && /Jane Doe/.test(new RedactionLeakError(found).message));
}

// --- Owner passwords, locked and broken files, many pages, Cancel ----------------------
{
  const doc = await PDFDocument.create();
  const font = await helvetica(doc);
  doc.addPage([595, 842]).drawText("Secret plan for Jane Doe", { x: 72, y: 700, size: 12, font });
  const plain = await doc.save();
  const owner = await SecurePDFDocument.load(plain);
  owner.encrypt({ ownerPassword: "owner-only", userPassword: "", permissions: { printing: "highResolution" } });
  const ownerBytes = await owner.save();
  const { list } = await marksFor(ownerBytes, "Jane Doe");
  const done = await redact(ownerBytes, list);
  const r = done.value ? await readAll(done.value.bytes) : null;
  check("a file with only an owner password is redacted", !!r && !/Jane/.test(r.pages[0].text) && /Secret plan/.test(r.pages[0].text), done.error?.message);
  if (done.value) check("…and its result isn't encrypted any more, so the check could read it all", !Buffer.from(done.value.bytes).toString("latin1").includes("/Encrypt"));

  const locked = await SecurePDFDocument.load(plain);
  locked.encrypt({ ownerPassword: "o", userPassword: "user" });
  const lockedBytes = await locked.save();
  const lockedRun = await settle(redactPdf(lockedBytes, { pages: [], needles: [] }));
  check("a file that needs a password says to unlock it", lockedRun.error?.message === "This PDF is password-protected. Unlock it first.", lockedRun.error?.message);
  const lockedDoc = await settle(redactDocument(new Blob([lockedBytes as Uint8Array<ArrayBuffer>]), { marks: [box(0, { x0: 0, y0: 0, x1: 50, y1: 50 })], needles: [], dpi: 100, keepText: true }, { canvas }));
  check("…from the start too", /password-protected/.test(lockedDoc.error?.message ?? ""), lockedDoc.error?.message);
  const broken = await settle(redactDocument(new Blob([new TextEncoder().encode("not a pdf at all")]), { marks: [box(0, { x0: 0, y0: 0, x1: 50, y1: 50 })], needles: [], dpi: 100, keepText: true }, { canvas }));
  check("a file that isn't a PDF", broken.error?.message === "This file isn't a readable PDF.", broken.error?.message);
  const half = await settle(redactPdf(plain.slice(0, Math.floor(plain.length / 2)), { pages: [], needles: [] }));
  check("half a file", !!half.error && !/line:|offset=|PDFDict/.test(half.error.message), half.error?.message);

  const ctl = new AbortController();
  ctl.abort();
  const cancelled = await settle(redactDocument(new Blob([plain as Uint8Array<ArrayBuffer>]), { marks: list, needles: [], dpi: 100, keepText: true }, { canvas, signal: ctl.signal }));
  check("Cancel stops it", cancelled.error?.name === "AbortError", cancelled.error?.message);
  const ctl2 = new AbortController();
  ctl2.abort();
  const off = await settle(redactFile(new Blob([plain as Uint8Array<ArrayBuffer>]), { pages: [], needles: [] }, undefined, ctl2.signal));
  check("Cancel stops the writing too", off.error?.name === "AbortError", off.error?.message);

  const big = await PDFDocument.create();
  const bf = await helvetica(big);
  for (let i = 0; i < 150; i++) {
    const p = big.addPage(i % 2 ? [842, 595] : [595, 842]);
    p.drawText(`Page ${i + 1} ${i === 120 ? "ref 8001015009087" : "plain"}`, { x: 72, y: 400, size: 12, font: bf });
  }
  const bigBytes = await big.save();
  const t0 = performance.now();
  const { pages } = await textOf(bigBytes);
  const ids = preset(pages, "id");
  check("a long document: the ID number found on its page", ids.length === 1 && ids[0].page === 120, ids.map((m) => m.page));
  const ticks: number[] = [];
  const bigRun = await settle(
    (async () => {
      const { loaded } = await textOf(bigBytes);
      try {
        const plan = marks.planNeedles(pages, ids);
        return await redactDocument(new Blob([bigBytes as Uint8Array<ArrayBuffer>]), { marks: ids, needles: plan.needles, dpi: 100, keepText: true }, { loaded, canvas, progress: (f) => ticks.push(f) });
      } finally {
        loaded.destroy();
      }
    })()
  );
  const ms = performance.now() - t0;
  check("a long document: one page rebuilt, the rest kept, in reasonable time", !!bigRun.value && bigRun.value.report.pages === 1 && ms < 60000, { error: bigRun.error?.message, ms });
  check("a long document: progress only goes up and ends near the end", ticks.length > 3 && ticks.every((t, i) => i === 0 || t >= ticks[i - 1] - 1e-9) && ticks[ticks.length - 1] > 0.8, ticks.slice(-3));
  if (bigRun.value) {
    const r = await readAll(bigRun.value.bytes);
    check("a long document: 150 pages, the number gone, other pages' text kept", r.pages.length === 150 && !/8001015009087/.test(r.pages[120].text) && r.pages[3].text === "Page 4 plain", r.pages[120].text);
  }
}

// --- Marks fit fonts whose widths aren't Helvetica's -----------------------------------
/** Pixels of the needle's colour (pure red) on a page as drawn at 3 pixels to the point. */
async function redPixels(bytes: Uint8Array, page = 0): Promise<number> {
  const loaded = await loadForRender(bytes);
  try {
    const c = canvas();
    await loaded.renderPage(page + 1, c, 3, { pixelRatio: 1 });
    const { data } = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let p = 0; p < data.length; p += 4) if (data[p] > 170 && data[p + 1] < 90 && data[p + 2] < 90) n++;
    return n;
  } finally {
    loaded.destroy();
  }
}
{
  // Noto Sans: wider letters than Helvetica, and punctuation much wider, so a run's length shared out by Helvetica's widths lands a letter or more out.
  const NOTO = "./node_modules/@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff";
  const make = async (before: string, number: string, after: string) => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(NOTO), { subset: true });
    const page = doc.addPage([420, 200]);
    // One line, one run for pdf.js: the number is only a change of colour.
    const ops: string[] = [];
    const key = page.node.newFontDictionary("F1", font.ref);
    const hex = (t: string) => font.encodeText(t).toString();
    ops.push(`BT /${key} 12 Tf 20 120 Td 0 g ${hex(before)} Tj 1 0 0 rg ${hex(number)} Tj 0 g ${hex(after)} Tj ET`);
    page.pushOperators(...[]);
    const stream = doc.context.flateStream(ops.join("\n"));
    page.node.set(PDFName.of("Contents"), doc.context.register(stream));
    const x0 = 20 + font.widthOfTextAtSize(before, 12);
    return { bytes: await doc.save(), x0, x1: x0 + font.widthOfTextAtSize(number, 12) };
  };
  for (const [name, before, after] of [
    ["symbols", "Ref #@%&*!!!!!!!!!!!!!!!!!! ", " ;;;;;;;;;;;;;;;;;;;;"],
    ["dot leaders", "Card number ............................ ", ""],
  ] as const) {
    const { bytes, x0, x1 } = await make(before, "4111 1111 1111 1111".replace(name === "symbols" ? / /g : /^$/, ""), after);
    check(`${name}: the fixture draws the number in red`, (await redPixels(bytes)) > 200);
    const { loaded, pages } = await textOf(bytes);
    try {
      const guessed = preset(pages, "card");
      const g = guessed[0]?.rects[0];
      if (name === "symbols") check(`${name}: by Helvetica's widths alone the mark misses part of the number`, !!g && (g.x0 > x0 + 0.5 || g.x1 < x1 - 0.5), { g, x0, x1 });
      await placeExactly(loaded, pages, [0]);
      const exact = preset(pages, "card");
      const r = exact[0]?.rects[0];
      check(`${name}: read with the font's widths, the mark covers the whole number`, exact.length === 1 && !!r && r.x0 <= x0 && r.x1 >= x1 && r.x0 > x0 - 4 && r.x1 < x1 + 4, { r, x0, x1 });
      const plan = marks.planNeedles(pages, exact);
      const done = await settle(redactDocument(new Blob([bytes as Uint8Array<ArrayBuffer>]), { marks: exact, needles: plan.needles, dpi: 150, keepText: true }, { loaded, canvas }));
      check(`${name}: no red pixel of the number is left in the result`, !!done.value && (await redPixels(done.value.bytes)) === 0, done.error?.message ?? (done.value && (await redPixels(done.value.bytes))));
      // A mark that stops inside a letter grows over the rest of it before it is painted.
      const short = { ...exact[0], id: marks.markId(), rects: [{ ...r!, x1: r!.x1 - 3 }] };
      const cut = await settle(redactDocument(new Blob([bytes as Uint8Array<ArrayBuffer>]), { marks: [short], needles: plan.needles, dpi: 150, keepText: true }, { loaded, canvas }));
      check(`${name}: a mark cut short inside the last digit still leaves no red`, !!cut.value && (await redPixels(cut.value.bytes)) === 0, cut.error?.message ?? (cut.value && (await redPixels(cut.value.bytes))));
    } finally {
      loaded.destroy();
    }
  }
  check("a mark grows over the ink it cuts, not along an underline", (() => {
    const c = canvasMod.createCanvas(100, 40);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 100, 40);
    ctx.fillStyle = "#000";
    ctx.fillRect(10, 10, 30, 12);
    // An underline the whole way along doesn't count as ink.
    ctx.fillRect(0, 20, 100, 1);
    const grown = growToInk(ctx, { x0: 15, y0: 8, x1: 35, y1: 24 }, 1);
    return grown.x0 === 10 && grown.x1 === 40 && grown.y0 === 8 && grown.y1 === 24;
  })());
}

// --- Text a crop hides --------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // An embedded font: its strings are glyph numbers, so only a reader finds the words, not a search of the bytes.
  const font = await doc.embedFont(readFileSync(FONTS + "LiberationSans-Regular.ttf"), { subset: true });
  doc.addPage([400, 400]).drawText("Client: Zanele Mokoena, 12 Main Road", { x: 40, y: 300, size: 14, font });
  const p2 = doc.addPage([400, 400]);
  p2.drawText("Summary kept on the cropped page", { x: 40, y: 300, size: 14, font });
  p2.drawText("Footer cut off by a crop: Zanele Mokoena, ID 8001015009087", { x: 20, y: 60, size: 11, font });
  // The top half only, as Crop PDF leaves it.
  p2.setMediaBox(0, 200, 400, 200);
  p2.setCropBox(0, 200, 400, 200);
  const p3 = doc.addPage([300, 300]);
  // A line that runs off the page's right edge: the name is past it.
  p3.drawText("The secret word is plain and then Zanele", { x: 40, y: 150, size: 14, font });
  p3.setCropBox(0, 0, 200, 300);
  const bytes = await doc.save();

  const plain = await readAll(bytes);
  check("the fixture: no reader shows the name on page 2", !/Zanele/.test(plain.pages[1].text));
  const loaded = await loadForRender(bytes);
  const wide = await openWide(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  try {
    check("a widened copy can be read", !!wide);
    const pages = await readText(loaded, { wide });
    check("text outside the visible area is read apart from what shows", pages.get(1)!.hidden!.some((r) => /Zanele Mokoena/.test(r.str)) && !pages.get(1)!.runs.some((r) => /Zanele/.test(r.str)));
    const found = search(pages, "Zanele Mokoena");
    check("search finds it there too, as a mark with nothing to paint", found.length === 2 && found[1].page === 1 && found[1].hidden === true && found[1].rects.length === 0, found.map((m) => [m.page, m.hidden]));
    check("…named so in the list", /outside the visible page/.test(marks.markLabel(found[1])));
    const word = search(pages, "Zanele");
    check("a match past the page's edge, in a line that starts on it, is outside the visible area too", word.some((m) => m.page === 2 && m.hidden), word.map((m) => [m.page, m.hidden]));

    // Only the copy that shows marked: the one a crop hides is a copy to decide about.
    const plan = marks.planNeedles(pages, [found[0]]);
    check("the copies prompt lists the hidden copy, said to be outside the visible area", plan.copies.some((c) => c.page === 1 && c.hidden), plan.copies);
    for (const n of plan.needles) n.allowed = {};
    const refused = await settle(redactDocument(new Blob([bytes as Uint8Array<ArrayBuffer>]), { marks: [found[0]], needles: plan.needles, dpi: 100, keepText: true }, { loaded, canvas }));
    check("left unmarked, the check after finds it and says where", refused.error instanceof RedactionLeakError && /outside the visible area of page 2/.test(refused.error.message), refused.error?.message);

    const all = [...found, ...word.filter((m) => m.page === 2)];
    const both = marks.planNeedles(pages, all);
    const done = await settle(redactDocument(new Blob([bytes as Uint8Array<ArrayBuffer>]), { marks: all, needles: both.needles, dpi: 100, keepText: true }, { loaded, canvas }));
    check("marked, the pages with hidden copies are rebuilt and the check passes", !!done.value && done.value.report.pages === 3, done.error?.message);
    if (done.value) {
      const out = await loadForRender(done.value.bytes);
      const outWide = await openWide(new Blob([done.value.bytes as Uint8Array<ArrayBuffer>]));
      const text = await readText(out, { wide: outWide });
      out.destroy();
      outWide?.destroy();
      check("…and nothing of the name is left, outside the visible area or in it", [...text.values()].every((t) => !/Zanele/.test(marks.allText(t))));
      check("…while what shows on page 2 is still searchable", /Summary kept/.test(marks.allText(text.get(1)!)));
    }
  } finally {
    loaded.destroy();
    wide?.destroy();
  }
}

// --- Plan limits -------------------------------------------------------------------
{
  const { LIMITS } = await import("../lib/limits.ts");
  check("pages rebuilt at once have a limit per plan, higher with Pro", LIMITS.guest.redactPages === LIMITS.free.redactPages && LIMITS.pro.redactPages > LIMITS.free.redactPages && LIMITS.team.redactPages === LIMITS.pro.redactPages);
}

// --- Registered like the other tools ---------------------------------------------
{
  const tool = getTool("redact-pdf");
  check("registered once, under Security", !!tool && TOOLS.filter((t) => t.slug === "redact-pdf").length === 1 && tool.category === "security", tool?.category);
  check("its own panel", !!tool && panelSpec(tool).kind === "redact");
  check("search finds it by what people type", ["redact", "black out", "blackout", "censor", "hide text", "remove personal"].every((q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "redact-pdf")));
  check("in the sitemap", sitemap().some((u) => u.url.endsWith("/tools/redact-pdf")));
  check("related tools are real tools", !!tool && relatedTools(tool.slug).length > 0 && relatedTools(tool.slug).every((t) => getTool(t.slug)));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
