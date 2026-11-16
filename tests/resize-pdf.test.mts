// Resize PDF: pages onto one paper size (or 2 or 4 to a sheet), checked by
// opening the results with pdf.js as an independent reader: page sizes, where
// the text lands, links, bookmarks, flattened form values and notes. Also
// turned pages, mixed sizes, owner-password and locked files, broken files,
// a long document, Cancel, and the worker hand-off.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const { resizePdf } = await import("../lib/pdf/resize/index.ts");
const { readOptions, layout, sheetFor, cells, place, PAPER, paperName, describeSize } = await import("../lib/pdf/resize/geometry.ts");
const { resizeFile } = await import("../lib/pdf/resize/off-thread.ts");
const { resizeTool } = await import("../lib/pdf/toolkit.ts");
const { friendlyPdfError } = await import("../lib/pdf/errors.ts");

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;

const A4 = { w: PAPER.a4.width, h: PAPER.a4.height };
const opts = (o: Record<string, string>) => readOptions({ size: "a4", orientation: "auto", fit: "fit", margin: "0", perSheet: "1", ...o });

interface Item {
  str: string;
  x: number;
  y: number;
}
interface ReadPage {
  width: number;
  height: number;
  rotate: number;
  items: Item[];
  annotations: { subtype: string; rect: number[]; url?: string; dest?: unknown; contents?: string }[];
}

/** Each page as pdf.js shows it: size, text with its spot (from the top left) and annotations. */
async function read(bytes: Uint8Array): Promise<{ pages: ReadPage[]; outline: { title: string; dest: unknown }[]; numPages: number; destPage: (dest: unknown) => Promise<number> }> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages: ReadPage[] = [];
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
    const annotations = (await page.getAnnotations()).map((a: Record<string, unknown>) => ({
      subtype: a.subtype as string,
      rect: a.rect as number[],
      url: a.url as string | undefined,
      dest: a.dest,
      contents: (a.contentsObj as { str?: string } | undefined)?.str,
    }));
    pages.push({ width: vp.width, height: vp.height, rotate: page.rotate, items, annotations });
  }
  const outline = ((await doc.getOutline()) ?? []).map((o) => ({ title: o.title, dest: o.dest }));
  const destPage = async (dest: unknown) => {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[]);
    return (await doc.getPageIndex(explicit![0] as { num: number; gen: number })) + 1;
  };
  return { pages, outline, numPages: doc.numPages, destPage };
}

const textOf = (p: ReadPage) => p.items.map((i) => i.str).join(" ");
const itemAt = (p: ReadPage, str: string) => p.items.find((i) => i.str === str);

/** Pages of the given sizes (and turns), each saying "Page N" near its top-left corner as shown. */
async function makePdf(pages: { size: [number, number]; rotate?: number }[]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, spec] of pages.entries()) {
    const page = doc.addPage(spec.size);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    // Written upright as shown: pdf-lib's pageFrame logic, by hand.
    const [w, h] = spec.size;
    const r = spec.rotate ?? 0;
    const at = (u: number, v: number) =>
      r === 90 ? { x: w - v, y: u } : r === 180 ? { x: w - u, y: h - v } : r === 270 ? { x: v, y: h - u } : { x: u, y: v };
    const shownH = r === 90 || r === 270 ? w : h;
    const p = at(40, shownH - 60);
    page.drawText(`Page ${i + 1}`, { x: p.x, y: p.y, size: 14, font, rotate: degrees(r) });
    page.drawRectangle({ x: 0, y: 0, width: w, height: h, borderColor: rgb(0, 0, 1), borderWidth: 2 });
  }
  return doc.save();
}

// --- Geometry ---------------------------------------------------------------
{
  const o = opts({});
  check("A4 is 595.28 × 841.89 pt", near(o.width, 595.28, 0.01) && near(o.height, 841.89, 0.01));
  check("Letter preset is 612 × 792", readOptions({ size: "letter" }).width === 612 && readOptions({ size: "letter" }).height === 792);
  const inches = readOptions({ size: "custom", width: "8.5", height: "11", unit: "in" });
  check("custom inches → points", inches.width === 612 && inches.height === 792, inches);
  const mm = readOptions({ size: "custom", width: "100,5", height: "200", unit: "mm" });
  check("custom mm with a decimal comma", near(mm.width, 100.5 * 72 / 25.4, 0.001), mm);
  const errs = ["abc", "0", "-5", "", "6000"].map((w) => {
    try {
      readOptions({ size: "custom", width: w, height: "100", unit: "mm" });
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  });
  check("bad custom sizes are refused in plain words", errs.every((e) => e === "Enter a width and height between 25 and 5080 mm."), errs);
  check("an unknown preset falls back to A4", readOptions({ size: "nope" }).width === o.width);
  check("margins are only the offered ones", readOptions({ margin: "10" }).margin > 28 && readOptions({ margin: "13" }).margin === 0);

  check("auto: landscape page → landscape sheet", sheetFor({ width: 800, height: 600 }, o).width > sheetFor({ width: 800, height: 600 }, o).height);
  check("portrait forced on a landscape page", sheetFor({ width: 800, height: 600 }, opts({ orientation: "portrait" })).width === o.width);
  const two = opts({ perSheet: "2" });
  check("2 per sheet: portrait pages go side by side on a landscape sheet", sheetFor({ width: 600, height: 800 }, two).width > A4.w + 1);
  const c2 = cells(sheetFor({ width: 600, height: 800 }, two), two);
  check("2 per sheet: two cells, left then right", c2.length === 2 && c2[0].x < c2[1].x && c2[0].y === c2[1].y, c2);
  const four = opts({ perSheet: "4", margin: "10" });
  const c4 = cells(sheetFor({ width: 600, height: 800 }, four), four);
  check("4 per sheet: 2 × 2, reading order", c4.length === 4 && c4[0].y === c4[1].y && c4[0].y > c4[2].y && c4[0].x < c4[1].x, c4);
  let tooBig = "";
  try {
    cells({ width: 100, height: 100 }, opts({ margin: "20" }));
  } catch (err) {
    tooBig = (err as Error).message;
  }
  check("margins that leave no room are refused", /no room/.test(tooBig), tooBig);
  const cell = { x: 0, y: 0, width: 200, height: 100 };
  const fit = place({ width: 100, height: 100 }, cell, "fit");
  const fill = place({ width: 100, height: 100 }, cell, "fill");
  const none = place({ width: 100, height: 100 }, cell, "none");
  check("fit keeps it inside, centred", fit.scale === 1 && fit.x === 50 && fit.y === 0, fit);
  check("fill covers the cell", fill.scale === 2 && fill.x === 0 && fill.y === -50, fill);
  check("no scaling centres it as it is", none.scale === 1 && none.x === 50, none);
  check("five pages at 4 a sheet make two sheets", layout(Array(5).fill({ width: 600, height: 800 }), four).map((s) => s.pages.length).join() === "4,1");
  check("paper names either way round", paperName(842, 595) === "A4" && paperName(612, 792) === "Letter" && paperName(500, 500) === undefined);
  check("sizes described in mm", describeSize(A4.w, A4.h) === "210 × 297 mm");
}

// --- Mixed sizes become one size, text kept and placed --------------------
{
  const src = await makePdf([{ size: [612, 792] }, { size: [842, 595] }, { size: [200, 100] }, { size: [1191, 1684] }]);
  const before = await read(src);
  const out = await resizePdf(src, opts({}));
  const after = await read(out);
  check("same number of pages", after.numPages === 4);
  check(
    "every page is A4, each keeping its orientation",
    after.pages.every((p, i) => (i === 1 || i === 2 ? near(p.width, A4.h) && near(p.height, A4.w) : near(p.width, A4.w) && near(p.height, A4.h))),
    after.pages.map((p) => [p.width, p.height])
  );
  check("text stays text", after.pages.every((p, i) => textOf(p) === `Page ${i + 1}`), after.pages.map(textOf));
  // Letter → A4: scale min(595.28/612, 841.89/792), centred top to bottom.
  const s = Math.min(A4.w / 612, A4.h / 792);
  const b = itemAt(before.pages[0], "Page 1")!;
  const a = itemAt(after.pages[0], "Page 1")!;
  const y0 = (A4.h - 792 * s) / 2;
  check("Letter page: text where the fit puts it", near(a.x, b.x * s) && near(a.y, A4.h - y0 - (792 - b.y) * s), { a, b, s });
  // The small landscape page grows to fill a landscape A4.
  const small = itemAt(after.pages[2], "Page 3")!;
  const s3 = Math.min(A4.h / 200, A4.w / 100);
  check("a small page is scaled up", near(small.x, 40 * s3, 1), { small, s3 });
  const doc = await PDFDocument.load(out);
  check("old Trim/Bleed boxes go, crop box is the new page", doc.getPages().every((p) => near(p.getCropBox().width, p.getMediaBox().width)));
}

// --- Turned pages -------------------------------------------------------------
for (const rotate of [90, 180, 270]) {
  const src = await makePdf([{ size: [595.28, 841.89], rotate }]);
  const before = await read(src);
  const out = await resizePdf(src, opts({}));
  const after = await read(out);
  const shownLandscape = rotate !== 180;
  const p = after.pages[0];
  const b = itemAt(before.pages[0], "Page 1")!;
  const a = itemAt(p, "Page 1");
  check(
    `/Rotate ${rotate}: shown the same way, same size, no rotation left`,
    p.rotate === 0 && (shownLandscape ? near(p.width, A4.h) && near(p.height, A4.w) : near(p.width, A4.w)),
    { w: p.width, h: p.height, r: p.rotate }
  );
  check(`/Rotate ${rotate}: text upright at the same spot`, !!a && near(a.x, b.x, 1) && near(a.y, b.y, 1), { a, b });
}
{
  // A turned page onto Letter: scaled about its shown size.
  const src = await makePdf([{ size: [595.28, 841.89], rotate: 90 }]);
  const after = await read(await resizePdf(src, opts({ size: "letter" })));
  check("turned page onto Letter is landscape Letter", near(after.pages[0].width, 792) && near(after.pages[0].height, 612));
}

// --- Fit modes and margins ------------------------------------------------------
{
  const src = await makePdf([{ size: [400, 400] }]);
  const before = itemAt((await read(src)).pages[0], "Page 1")!;
  const fill = await resizePdf(src, opts({ fit: "fill" }));
  const fillDoc = await PDFDocument.load(fill);
  const prefix = new TextDecoder().decode(
    (fillDoc.context.lookup(fillDoc.getPages()[0].node.Contents()!.get(0)) as unknown as { contents: Uint8Array }).contents
  );
  check("fill: the edges are clipped to the page", /^0 0 595\.2756 841\.8898 re W n /.test(prefix), prefix);
  const sFill = A4.h / 400;
  // Its left side is cut off, and pdf.js leaves out letters off the page: "Pa" is gone.
  const filled = (await read(fill)).pages[0].items;
  const startsAt = (A4.w - 400 * sFill) / 2 + before.x * sFill;
  check("fill: scaled to cover the page, its edges cut off", startsAt < 0 && filled.length === 1 && /^g?e 1$/.test(filled[0].str), { startsAt, filled });
  const none = await read(await resizePdf(src, opts({ fit: "none" })));
  const n = itemAt(none.pages[0], "Page 1")!;
  check("no scaling: same size, centred", near(n.x, (A4.w - 400) / 2 + before.x) && near(n.y, (A4.h - 400) / 2 + before.y), n);
  const margin = await read(await resizePdf(src, opts({ margin: "20" })));
  const m = itemAt(margin.pages[0], "Page 1")!;
  const mPt = (20 * 72) / 25.4;
  const sM = (A4.w - 2 * mPt) / 400;
  check("margin: page fits inside the margin", near(m.x, mPt + before.x * sM, 1), { m, sM });
}

// --- Links, bookmarks and notes move with their page ----------------------------
async function withLinks(rotate = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  if (rotate) p2.setRotation(degrees(rotate));
  p1.drawText("Contents", { x: 72, y: 700, size: 14, font });
  p2.drawText("Chapter two", { x: 72, y: 500, size: 14, font });
  const ctx = doc.context;
  const web = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 600, 272, 620], Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/") } })
  );
  const inner = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 560, 272, 580], Border: [0, 0, 0], Dest: [p2.ref, "XYZ", 72, 520, 0] }));
  // A comment with its own picture: a square, drawn in a 100 × 50 box.
  const ap = ctx.register(ctx.stream("0 0 1 RG 2 w 1 1 98 48 re S", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 50] }));
  const note = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [300, 300, 400, 350], Contents: PDFString.of("Check this"), C: [0, 0, 1], AP: { N: ap } })
  );
  const highlight = ctx.register(
    ctx.obj({ Type: "Annot", Subtype: "Highlight", Rect: [72, 495, 172, 515], QuadPoints: [72, 515, 172, 515, 72, 495, 172, 495], C: [1, 1, 0] })
  );
  p1.node.set(PDFName.of("Annots"), ctx.obj([web, inner]));
  p2.node.set(PDFName.of("Annots"), ctx.obj([note, highlight]));
  // One bookmark to page 2.
  const outlines = ctx.nextRef();
  const item = ctx.register(ctx.obj({ Title: PDFString.of("Chapter two"), Parent: outlines, Dest: [p2.ref, "XYZ", 72, 520, 0] }));
  ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  return doc.save();
}
{
  const src = await withLinks();
  const out = await resizePdf(src, opts({}));
  const after = await read(out);
  const s = Math.min(A4.w / 612, A4.h / 792);
  const y0 = (A4.h - 792 * s) / 2;
  const web = after.pages[0].annotations.find((a) => a.url);
  check("web link kept, its box scaled with the page", !!web && near(web.rect[0], 72 * s) && near(web.rect[1], y0 + 600 * s) && near(web.rect[2], 272 * s), web);
  const inner = after.pages[0].annotations.find((a) => a.subtype === "Link" && !a.url);
  const dest = inner?.dest as unknown[] | undefined;
  check("inner link still leads to page 2", !!dest && (await after.destPage(dest)) === 2, dest);
  check("inner link's spot moved with the page", !!dest && near(dest[2] as number, 72 * s) && near(dest[3] as number, y0 + 520 * s), dest);
  check("bookmark kept, to page 2", after.outline.length === 1 && (await after.destPage(after.outline[0].dest)) === 2, after.outline);
  const note = after.pages[1].annotations.find((a) => a.subtype === "Square");
  check(
    "note moved and scaled, its text kept",
    !!note && note.contents === "Check this" && near(note.rect[0], 300 * s) && near(note.rect[2] - note.rect[0], 100 * s),
    note
  );
  const doc = await PDFDocument.load(out);
  const hl = doc.getPages()[1].node.Annots()!.lookup(1, PDFDict).lookup(PDFName.of("QuadPoints"), PDFArray);
  check("highlight's quad points moved too", near((hl.lookup(0) as PDFNumber).asNumber(), 72 * s), hl.toString());
}
{
  // On a turned page the note's picture turns with the content.
  const src = await withLinks(90);
  const out = await resizePdf(src, opts({}));
  const doc = await PDFDocument.load(out);
  const note = doc.getPages()[1].node.Annots()!.lookup(0, PDFDict);
  const ap = note.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N")) as unknown as { dict: PDFDict };
  const matrix = ap.dict.lookup(PDFName.of("Matrix"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
  check("turned page: note picture turned a quarter", near(matrix[0], 0, 1e-6) && near(Math.abs(matrix[1]), 1, 1e-6), matrix);
  const rect = note.lookup(PDFName.of("Rect"), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
  const sT = Math.min(A4.h / 792, A4.w / 612);
  check("turned page: note box turned too (50 wide, 100 tall, scaled)", near(rect[2] - rect[0], 50 * sT) && near(rect[3] - rect[1], 100 * sT), rect);
  const after = await read(out);
  const dest = after.outline[0].dest as unknown[];
  check("turned page: bookmark still leads there", (await after.destPage(dest)) === 2, dest);
}

// --- Forms are flattened first -----------------------------------------------
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const name = form.createTextField("name");
  name.setText("Thabo Mokoena");
  name.addToPage(page, { x: 72, y: 600, width: 200, height: 24 });
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 72, y: 560, width: 16, height: 16 });
  agree.check();
  const src = await doc.save();
  const out = await resizePdf(src, opts({}));
  const after = await read(out);
  const loaded = await PDFDocument.load(out);
  check("form fields are flattened (none left)", !loaded.catalog.getAcroForm() || loaded.getForm().getFields().length === 0);
  check("no widgets left on the page", after.pages[0].annotations.filter((a) => a.subtype === "Widget").length === 0, after.pages[0].annotations);
  const value = itemAt(after.pages[0], "Thabo Mokoena");
  const s = Math.min(A4.w / 612, A4.h / 792);
  const y0 = (A4.h - 792 * s) / 2;
  check("the typed value is on the page, where its field was", !!value && near(value.x, 74 * s, 4) && value.y < A4.h - y0 - 600 * s && value.y > A4.h - y0 - 624 * s, value);
}
{
  // A value Helvetica can't draw, in a form that asks readers to draw its
  // fields: the fields stay, and move with the page.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const field = doc.getForm().createTextField("city");
  field.addToPage(page, { x: 72, y: 600, width: 200, height: 24 });
  (field.acroField.dict as PDFDict).set(PDFName.of("V"), PDFString.of("Москва"));
  field.acroField.getWidgets()[0].dict.delete(PDFName.of("AP"));
  doc.getForm().acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  const out = await resizePdf(await doc.save({ updateFieldAppearances: false }), opts({}));
  const loaded = await PDFDocument.load(out);
  const kept = loaded.getForm().getFields();
  const s = Math.min(A4.w / 612, A4.h / 792);
  const rect = kept[0]?.acroField.getWidgets()[0].getRectangle();
  // pdf-lib draws the box half a border wider: 71.5 to 272.5.
  check("undrawable value: field kept, box moved with the page", kept.length === 1 && !!rect && near(rect.x, 71.5 * s) && near(rect.width, 201 * s), rect);
}

// --- Locked and broken files ----------------------------------------------------
{
  const plain = await makePdf([{ size: [612, 792] }, { size: [612, 792] }]);
  const ownerOnly = await (async () => {
    const d = await SecurePDFDocument.load(plain);
    d.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: "highResolution" } });
    return d.save({ useObjectStreams: false });
  })();
  const out = await resizePdf(ownerOnly, opts({}));
  const after = await read(out);
  check("owner-password file resizes (it opens without a password)", after.numPages === 2 && near(after.pages[0].width, A4.w) && textOf(after.pages[1]) === "Page 2", after.pages.map(textOf));
  const locked = await (async () => {
    const d = await SecurePDFDocument.load(plain);
    d.encrypt({ userPassword: "pw", ownerPassword: "pw" });
    return d.save({ useObjectStreams: false });
  })();
  const fails = async (bytes: Uint8Array) => {
    try {
      await resizePdf(bytes, opts({}));
      return "";
    } catch (err) {
      return friendlyPdfError(err).message;
    }
  };
  check("password to open: says unlock first", (await fails(locked)) === "This PDF is password-protected. Unlock it first.");
  check("not a PDF: plain words", (await fails(new TextEncoder().encode("hello, not a pdf"))) === "This file isn't a readable PDF.");
  check("empty file: plain words", (await fails(new Uint8Array())) === "This file isn't a readable PDF.");
  const cut = plain.slice(0, Math.floor(plain.length / 3));
  const cutMsg = await fails(cut);
  check("cut-off file: plain words or still readable", cutMsg === "" || cutMsg === "This file isn't a readable PDF.", cutMsg);
}

// --- 2 and 4 to a sheet -------------------------------------------------------------
{
  const src = await withLinks();
  const two = await resizePdf(src, opts({ perSheet: "2" }));
  const after = await read(two);
  check("2 a sheet: two pages make one landscape A4", after.numPages === 1 && near(after.pages[0].width, A4.h) && near(after.pages[0].height, A4.w));
  const c = itemAt(after.pages[0], "Contents")!;
  const ch = itemAt(after.pages[0], "Chapter two")!;
  check("2 a sheet: first page on the left, second on the right", !!c && !!ch && c.x < A4.h / 2 && ch.x > A4.h / 2, { c, ch });
  check("2 a sheet: the web link came along", after.pages[0].annotations.some((a) => a.url === "https://example.com/"));
  check("2 a sheet: the note came along", after.pages[0].annotations.some((a) => a.subtype === "Square" && a.contents === "Check this"));
  const inner = after.pages[0].annotations.find((a) => a.subtype === "Link" && !a.url);
  check("2 a sheet: inner link now leads to the sheet", !!inner && (await after.destPage(inner.dest)) === 1, inner);
  check("2 a sheet: bookmark leads to the sheet", after.outline.length === 1 && (await after.destPage(after.outline[0].dest)) === 1);
  const doc = await PDFDocument.load(two);
  check("2 a sheet: old pages are gone from the file", doc.getPageCount() === 1 && doc.getPages()[0].node.Annots()!.size() === 4);

  const five = await makePdf(Array.from({ length: 5 }, () => ({ size: [612, 792] as [number, number] })));
  const four = await read(await resizePdf(five, opts({ perSheet: "4", margin: "5" })));
  check("4 a sheet: five pages, two portrait sheets", four.numPages === 2 && near(four.pages[0].width, A4.w) && near(four.pages[1].height, A4.h));
  const at = (n: number) => itemAt(four.pages[0], `Page ${n}`)!;
  check(
    "4 a sheet: reading order left to right, then down",
    at(1).x < at(2).x && near(at(1).y, at(2).y) && at(3).y > at(1).y && near(at(3).x, at(1).x),
    [1, 2, 3, 4].map(at)
  );
  check("4 a sheet: last sheet has the fifth page", textOf(four.pages[1]) === "Page 5");

  const turned = await makePdf([{ size: [595.28, 841.89], rotate: 90 }, { size: [595.28, 841.89] }]);
  const mixed = await read(await resizePdf(turned, opts({ perSheet: "2" })));
  check("2 a sheet with a turned page: both readable", textOf(mixed.pages[0]).includes("Page 1") && textOf(mixed.pages[0]).includes("Page 2"), textOf(mixed.pages[0]));

  const flat = await (async () => {
    const d = await PDFDocument.create();
    const page = d.addPage([612, 792]);
    const f = d.getForm().createTextField("who");
    f.setText("Lerato");
    f.addToPage(page, { x: 72, y: 600, width: 200, height: 24 });
    d.addPage([612, 792]);
    return d.save();
  })();
  const flatOut = await read(await resizePdf(flat, opts({ perSheet: "2" })));
  check("2 a sheet: form values flattened onto the sheet", textOf(flatOut.pages[0]).includes("Lerato"), textOf(flatOut.pages[0]));
}

// --- A long document, progress and Cancel ---------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 400; i++) doc.addPage(i % 3 ? [612, 792] : [842, 595]).drawText(`Page ${i + 1}`, { x: 40, y: 40, size: 12, font });
  const src = await doc.save();
  const labels: string[] = [];
  const t0 = performance.now();
  const out = await resizePdf(src, opts({}), (_f, label) => labels.push(label));
  const ms = performance.now() - t0;
  const loaded = await PDFDocument.load(out);
  check("400 pages: all resized", loaded.getPageCount() === 400 && loaded.getPages().every((p) => near(Math.min(p.getWidth(), p.getHeight()), A4.w)));
  check("400 pages: progress reported, ends with saving", labels.length > 5 && labels.at(-1) === "Saving", labels.slice(0, 3));
  check("400 pages: quick (under 10 s here)", ms < 10_000, Math.round(ms));
  const ctl = new AbortController();
  let name = "";
  try {
    await resizePdf(src, opts({}), (f) => f > 0.2 && ctl.abort(), ctl.signal);
  } catch (err) {
    name = (err as Error).name;
  }
  check("Cancel stops it", name === "AbortError", name);
  const up = await resizePdf(src, opts({ perSheet: "4" }));
  check("400 pages at 4 a sheet: 100 sheets", (await PDFDocument.load(up)).getPageCount() === 100);
}

// --- The tool: options, names, worker -------------------------------------------
{
  const src = await makePdf([{ size: [612, 792] }]);
  const file = new File([src.slice() as unknown as BlobPart], "report.pdf", { type: "application/pdf" });
  const res = await resizeTool([file], { size: "a4", orientation: "auto", fit: "fit", margin: "0", perSheet: "1" });
  check("tool: report.pdf → report-resized.pdf", res.filename === "report-resized.pdf");
  const nup = await resizeTool([file], { size: "a4", orientation: "auto", fit: "fit", margin: "0", perSheet: "2" });
  check("tool: 2 a sheet → report-2-up.pdf", nup.filename === "report-2-up.pdf");
  let msg = "";
  try {
    await resizeTool([file], { size: "custom", width: "x", height: "100", unit: "in" });
  } catch (err) {
    msg = (err as Error).message;
  }
  check("tool: bad custom size says what's allowed", msg === "Enter a width and height between 1 and 200 in.", msg);

  // In a browser it runs in a worker, which Cancel ends at once.
  class FakeWorker {
    static all: FakeWorker[] = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { preventDefault(): void }) => void) | null = null;
    terminated = false;
    posted: unknown[] = [];
    constructor(public url: URL) {
      FakeWorker.all.push(this);
    }
    postMessage(data: unknown) {
      this.posted.push(data);
    }
    terminate() {
      this.terminated = true;
    }
  }
  const g = globalThis as unknown as { window?: unknown; Worker?: unknown };
  g.window = globalThis;
  g.Worker = FakeWorker;
  try {
    const ctl = new AbortController();
    const job = resizeFile(file, opts({}), undefined, ctl.signal).then(
      () => "finished",
      (err) => (err as Error).name
    );
    await new Promise((r) => setTimeout(r, 20));
    const w = FakeWorker.all[0];
    check("worker: gets the bytes and the options", !!w && (w.posted[0] as { opts: { width: number } }).opts.width === opts({}).width);
    ctl.abort();
    check("worker: Cancel ends it", (await job) === "AbortError" && w.terminated);
    const progress: string[] = [];
    const ok = resizeFile(file, opts({}), (_f, label) => progress.push(label));
    await new Promise((r) => setTimeout(r, 20));
    const w2 = FakeWorker.all[1];
    w2.onmessage!({ data: { type: "progress", fraction: 0.5, label: "Page 1 of 1" } });
    w2.onmessage!({ data: { type: "done", bytes: new Uint8Array([1, 2, 3]) } });
    check("worker: progress passed on, result returned", (await ok).length === 3 && progress[0] === "Page 1 of 1" && w2.terminated);
    const bad = resizeFile(file, opts({}));
    await new Promise((r) => setTimeout(r, 20));
    FakeWorker.all[2].onmessage!({ data: { type: "error", message: "This PDF is password-protected. Unlock it first." } });
    check("worker: its error message comes through", await bad.then(() => "", (err) => (err as Error).message) === "This PDF is password-protected. Unlock it first.");
    const crashed = resizeFile(file, opts({}));
    await new Promise((r) => setTimeout(r, 20));
    FakeWorker.all[3].onerror!({ preventDefault() {} });
    check("worker didn't load: runs here instead", (await PDFDocument.load(await crashed)).getPageCount() === 1);
  } finally {
    delete g.window;
    delete g.Worker;
  }
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
