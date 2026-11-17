// Crop PDF: the box, its keys and drags, the pages it goes on, and the files
// it writes, opened again with pdf.js as an independent reader: page sizes,
// which text is still shown and where, every page box, links, notes and
// fields in and out of the box, and, with "Remove what's outside the box",
// that what was outside is gone from the file itself. Also turned pages,
// pages whose MediaBox doesn't start at 0,0, mixed sizes, owner-password and
// locked files, broken files, a long document, white-margin trimming and
// Cancel.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
  type PDFPage,
} from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const geo = await import("../lib/pdf/crop/geometry.ts");
const { cropPdf } = await import("../lib/pdf/crop/index.ts");
const { cropFile } = await import("../lib/pdf/crop/off-thread.ts");
const { cropDocument, NothingToTrimError } = await import("../lib/pdf/crop/run.ts");
const { findMargins } = await import("../lib/pdf/crop/pictures.ts");
const { loadForRender } = await import("../lib/pdf/render.ts");

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
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
  (globalThis as Record<string, unknown>).document = {
    createElement: () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }),
  };
} catch {
  canvasMod = null;
}
const canvas = () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }) as unknown as HTMLCanvasElement;

const FONTS = "./node_modules/pdfjs-dist/standard_fonts/";
const M = (top: number, right: number, bottom: number, left: number) => ({ top, right, bottom, left });

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
  annotations: { subtype: string; rect: number[]; url?: string; fieldName?: string }[];
}

/** Each page as pdf.js shows it: size, text with its spot (from the top left) and annotations. */
async function read(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: FONTS }).promise;
  const pages: ReadPage[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((it): it is typeof it & { str: string; transform: number[] } => "str" in it && it.str.trim() !== "")
      .map((it) => {
        const t = pdfjs.Util.transform(vp.transform, it.transform);
        return { str: it.str.trim(), x: t[4], y: t[5] };
      });
    const annotations = (await page.getAnnotations()).map((a: Record<string, unknown>) => ({
      subtype: a.subtype as string,
      rect: a.rect as number[],
      url: a.url as string | undefined,
      fieldName: a.fieldName as string | undefined,
    }));
    pages.push({ width: vp.width, height: vp.height, rotate: page.rotate, items, annotations });
  }
  const outline = ((await doc.getOutline()) ?? []).map((o) => ({ title: o.title, dest: o.dest }));
  const destOf = async (dest: unknown) => {
    const explicit = (typeof dest === "string" ? await doc.getDestination(dest) : dest) as unknown[];
    return { page: (await doc.getPageIndex(explicit[0] as { num: number; gen: number })) + 1, args: explicit.slice(1) };
  };
  const out = { pages, outline, numPages: doc.numPages, destOf, destroy: () => doc.destroy() };
  return out;
}

/** The words pdf.js shows on the page: those that sit inside it. */
const shown = (p: ReadPage) =>
  p.items
    .filter((i) => i.x >= -0.5 && i.x <= p.width + 0.5 && i.y >= -0.5 && i.y <= p.height + 0.5)
    .map((i) => i.str)
    .sort()
    .join(" ");
const itemAt = (p: ReadPage, str: string) => p.items.find((i) => i.str === str);

/** Every stream in the file, decoded, as text: what someone digging in the file would find. */
async function rawText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let all = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      try {
        all += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1") + "\n";
      } catch {
        all += Buffer.from(obj.contents).toString("latin1") + "\n";
      }
    }
  }
  return all;
}
/** Whether `word` is in the file as a literal string or as pdf-lib's hex. */
const inFile = (raw: string, word: string) =>
  raw.includes(`(${word}`) || raw.toUpperCase().includes(Buffer.from(word, "latin1").toString("hex").toUpperCase());

interface Spec {
  size: [number, number];
  rotate?: number;
  /** A MediaBox that doesn't start at 0,0: [x, y] of its corner. */
  offset?: [number, number];
}

/**
 * Pages with words where they are shown (upright, whatever the turn): TOPLEFT
 * 40pt in and 60pt down, MIDDLE at the centre, LOWRIGHT near the far corner.
 */
async function makePdf(specs: Spec[], extra?: (doc: PDFDocument, page: PDFPage, at: (u: number, v: number) => { x: number; y: number }, i: number) => void) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, spec] of specs.entries()) {
    const [w, h] = spec.size;
    const [ox, oy] = spec.offset ?? [0, 0];
    const page = doc.addPage([w, h]);
    if (spec.offset) page.setMediaBox(ox, oy, w, h);
    const r = spec.rotate ?? 0;
    if (r) page.setRotation(degrees(r));
    // u from the left and v up from the bottom, as shown.
    const at = (u: number, v: number) =>
      r === 90 ? { x: ox + w - v, y: oy + u } : r === 180 ? { x: ox + w - u, y: oy + h - v } : r === 270 ? { x: ox + v, y: oy + h - u } : { x: ox + u, y: oy + v };
    const W = r % 180 ? h : w;
    const H = r % 180 ? w : h;
    const word = (text: string, u: number, v: number) => page.drawText(text, { ...at(u, v), size: 12, font, rotate: degrees(r) });
    word("TOPLEFT", 40, H - 60);
    word("MIDDLE", W / 2 - 20, H / 2);
    word(`PAGE${i + 1}`, W / 2 - 20, H / 2 - 20);
    word("LOWRIGHT", W - 110, 30);
    extra?.(doc, page, at, i);
  }
  return doc.save();
}

// --- The box: margins, units, drags and keys ------------------------------
{
  check("mm → points", near(geo.toPoints(25.4, "mm"), 72, 1e-9) && geo.toPoints(1, "in") === 72 && geo.toPoints(5, "pt") === 5);
  check("lengths read with a dot or a comma", near(geo.readLength("12,7", "mm")!, 36, 0.01) && geo.readLength(" 1.5 ", "in") === 108);
  check("lengths that aren't numbers, or are negative, are refused", ["", "abc", "-3", "1e3", "2 mm"].every((t) => geo.readLength(t, "mm") === null));
  check("lengths written for fields", geo.formatLength(36, "mm") === "12.7" && geo.formatLength(108, "in") === "1.5" && geo.formatLength(10.4, "pt") === "10");
  const page = { width: 600, height: 800 };
  const m = M(10, 20, 30, 40);
  const box = geo.boxFromMargins(page, m);
  check("margins → box → margins", box.x === 40 && box.y === 10 && box.width === 540 && box.height === 760 && geo.sameMargins(geo.marginsFromBox(page, box), m), box);
  check("margins that leave too little are named, with the page", /page 3/.test(geo.marginsProblem(page, M(0, 300, 0, 290), 3) ?? "") && geo.marginsProblem(page, m) === null);
  check("negative margins are refused", geo.marginsProblem(page, M(-1, 0, 0, 0)) === "Margins can't be less than 0.");

  const start = { x: 100, y: 100, width: 200, height: 300 };
  const moved = geo.dragBox(start, "move", 1000, -1000, page);
  check("a moved box stays on the page", moved.x === 400 && moved.y === 0 && moved.width === 200, moved);
  const se = geo.dragBox(start, "se", 50, 40, page);
  check("the bottom-right corner grows the box", se.x === 100 && se.width === 250 && se.height === 340, se);
  const nw = geo.dragBox(start, "nw", 500, 500, page);
  check("an edge stops short of the one across", nw.width === geo.MIN_SIDE && nw.height === geo.MIN_SIDE && nw.x + nw.width === 300, nw);
  const w = geo.dragBox(start, "w", -500, 0, page);
  check("an edge stops at the page", w.x === 0 && w.width === 300, w);
  check("a box drawn backwards", JSON.stringify(geo.boxBetween({ x: 300, y: 400 }, { x: 100, y: 50 }, page)) === JSON.stringify({ x: 100, y: 50, width: 200, height: 350 }));
  check("a box drawn off the page is held to it", geo.boxBetween({ x: -50, y: -50 }, { x: 700, y: 900 }, page).width === 600);

  const key = (k: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}) => ({ key: k, shiftKey: false, altKey: false, ...mods });
  check("arrows move the box 1pt", geo.nudgeBox(start, key("ArrowRight"), page)?.x === 101 && geo.nudgeBox(start, key("ArrowUp"), page)?.y === 99);
  check("Shift + arrows move it 10pt", geo.nudgeBox(start, key("ArrowDown", { shiftKey: true }), page)?.y === 110);
  const grown = geo.nudgeBox(start, key("ArrowRight", { altKey: true }), page)!;
  const shrunk = geo.nudgeBox(start, key("ArrowUp", { altKey: true, shiftKey: true }), page)!;
  check("Alt + arrows resize from the bottom-right", grown.width === 201 && grown.x === 100 && shrunk.height === 290 && shrunk.y === 100, { grown, shrunk });
  check("other keys do nothing", geo.nudgeBox(start, key("a"), page) === null);
  check("the box can't be moved off the page with keys", geo.nudgeBox({ x: 0, y: 0, width: 50, height: 50 }, key("ArrowLeft"), page)?.x === 0);
  check("the box reads out its size and place", geo.describeBox({ x: 72, y: 36, width: 144, height: 72 }, "in") === "2 × 1 in, 1 in from the left, 0.5 in from the top");

  const s = (scope: Parameters<typeof geo.scopePages>[0], range = "") => geo.scopePages(scope, 7, 2, range);
  check("all pages", s("all").pages.join() === "0,1,2,3,4,5,6");
  check("this page", s("current").pages.join() === "2");
  check("odd pages (1, 3, 5…)", s("odd").pages.join() === "0,2,4,6");
  check("even pages (2, 4, 6…)", s("even").pages.join() === "1,3,5");
  check("a typed range", s("range", "2-3, 6").pages.join() === "1,2,5" && s("range", "2-3, 6").problem === null);
  check("a bad range says why", s("range", "9").problem === "Pages go from 1 to 7." && s("range", "").problem !== null);
  check("a 1-page file has no even pages", geo.scopePages("even", 1, 0).problem !== null);
  check("the file name", geo.croppedName("Scan 3.PDF") === "Scan 3-cropped.pdf" && geo.croppedName(".pdf") === "document-cropped.pdf");
}

// --- Finding content on a picture -----------------------------------------
{
  const w = 100;
  const h = 80;
  const blank = new Uint8ClampedArray(w * h * 4).fill(255);
  check("a blank picture has no content", geo.contentBox(blank, w, h) === null);
  const ink = blank.slice();
  const dot = (x: number, y: number) => ink.set([0, 0, 0, 255], (y * w + x) * 4);
  for (let y = 20; y < 50; y++) for (let x = 30; x < 70; x++) dot(x, y);
  dot(2, 2); // dust
  const found = geo.contentBox(ink, w, h);
  check("content is found, a speck of dust isn't", JSON.stringify(found) === JSON.stringify({ x: 30, y: 20, width: 40, height: 30 }), found);
  const clear = blank.slice();
  for (let k = 0; k < clear.length; k += 4) clear[k + 3] = 0;
  clear.set([0, 0, 0, 0], 0);
  check("transparent pixels aren't content", geo.contentBox(clear, w, h) === null);
  const margins = geo.trimMargins(found, 0.5, { width: 200, height: 160 }, 6);
  check("trim: content plus padding, in points", !!margins && near(margins.left, 54) && near(margins.top, 34) && near(margins.right, 200 - 140 - 6) && near(margins.bottom, 160 - 100 - 6), margins);
  check("trim: padding stops at the page", geo.trimMargins({ x: 0, y: 0, width: 100, height: 80 }, 0.5, { width: 200, height: 160 }, 6) === null);
}

// --- Cropping hides what's outside, on every kind of page -----------------
{
  const src = await makePdf([{ size: [600, 800] }]);
  const { bytes, report } = await cropPdf(src, { crops: [{ page: 0, margins: M(100, 100, 100, 100) }] });
  const r = await read(bytes);
  const p = r.pages[0];
  check("the page is the size of the box", near(p.width, 400) && near(p.height, 600), [p.width, p.height]);
  check("only what's inside the box shows", shown(p) === "MIDDLE PAGE1", shown(p));
  const mid = itemAt(p, "MIDDLE")!;
  check("what's inside stays where it was in the box", near(mid.x, 300 - 20 - 100) && near(mid.y, 800 - 400 - 100), mid);
  check("the report counts the page", report.cropped === 1 && report.pictured === 0);
  const doc = await PDFDocument.load(bytes);
  const pg = doc.getPages()[0];
  const boxes = [pg.getMediaBox(), pg.getCropBox(), pg.getTrimBox(), pg.getBleedBox(), pg.getArtBox()];
  check("Media, Crop, Trim, Bleed and Art boxes all agree", boxes.every((b) => b.x === 100 && b.y === 100 && b.width === 400 && b.height === 600), boxes);
  const raw = await rawText(bytes);
  // pdf.js no longer lists it, but anyone reading the file's streams finds it.
  check("hidden, not deleted: what's outside is still in the file", inFile(raw, "TOPLEFT") && !p.items.some((i) => i.str === "TOPLEFT"));
  await r.destroy();
}

for (const rotate of [90, 180, 270]) {
  const src = await makePdf([{ size: [500, 700], rotate }]);
  // Shown sideways for 90 and 270: 700 wide, 500 tall.
  const W = rotate === 180 ? 500 : 700;
  const H = rotate === 180 ? 700 : 500;
  const { bytes } = await cropPdf(src, { crops: [{ page: 0, margins: M(80, 30, 10, 60) }] });
  const r = await read(bytes);
  const p = r.pages[0];
  check(`/Rotate ${rotate}: the box is taken from the page as shown`, near(p.width, W - 90) && near(p.height, H - 90) && p.rotate === rotate, [p.width, p.height, p.rotate]);
  check(`/Rotate ${rotate}: the top-left word is cut, the middle and bottom-right stay`, shown(p) === "LOWRIGHT MIDDLE PAGE1", shown(p));
  const mid = itemAt(p, "MIDDLE")!;
  check(`/Rotate ${rotate}: the middle word lands where it was, less the margins`, near(mid.x, W / 2 - 20 - 60, 1) && near(mid.y, H / 2 - 80, 1), mid);
  await r.destroy();
}

{
  // A MediaBox from 200,300, and a CropBox inside it already.
  const src = await makePdf([{ size: [600, 800], offset: [200, 300] }, { size: [600, 800], offset: [-100, -50], rotate: 90 }]);
  const pre = await PDFDocument.load(src);
  pre.getPages()[0].setCropBox(210, 310, 580, 780);
  const { bytes } = await cropPdf(await pre.save(), {
    crops: [
      { page: 0, margins: M(50, 50, 50, 50) },
      { page: 1, margins: M(100, 100, 100, 100) },
    ],
  });
  const doc = await PDFDocument.load(bytes);
  const [a, b] = doc.getPages();
  const crop = a.getCropBox();
  check("an offset MediaBox and an old CropBox: the box is cut from what was shown", crop.x === 260 && crop.y === 360 && crop.width === 480 && crop.height === 680, crop);
  check("an offset MediaBox: the MediaBox follows", JSON.stringify(a.getMediaBox()) === JSON.stringify(crop));
  const r = await read(bytes);
  check("an offset MediaBox: the right words still show", shown(r.pages[0]) === "MIDDLE PAGE1" && shown(r.pages[1]) === "MIDDLE PAGE2", r.pages.map(shown));
  check("an offset, turned MediaBox: shown 600 × 400", near(r.pages[1].width, 600) && near(r.pages[1].height, 400), [r.pages[1].width, r.pages[1].height]);
  const bc = b.getCropBox();
  check("an offset, turned MediaBox: the box in its own space", bc.x === 0 && bc.y === 50 && bc.width === 400 && bc.height === 600, bc);
  await r.destroy();
}

{
  // Mixed sizes, and the box on some pages only.
  const src = await makePdf([{ size: [612, 792] }, { size: [842, 595] }, { size: [300, 400] }, { size: [1191, 1684] }]);
  const margins = M(36, 36, 36, 36);
  const { bytes } = await cropPdf(src, { crops: [0, 2].map((page) => ({ page, margins })) });
  const r = await read(bytes);
  const sizes = r.pages.map((p) => [Math.round(p.width), Math.round(p.height)].join("x")).join(" ");
  check("mixed sizes: the same margins come off each page picked; the rest stay", sizes === "540x720 842x595 228x328 1191x1684", sizes);
  check("pages not picked keep all their words", shown(r.pages[1]) === "LOWRIGHT MIDDLE PAGE2 TOPLEFT", shown(r.pages[1]));
  await r.destroy();
  const odd = geo.scopePages("odd", 4, 0).pages;
  const { report } = await cropPdf(src, { crops: odd.map((page) => ({ page, margins })) });
  check("odd pages: pages 1 and 3", report.cropped === 2);
  const tooBig = await settle(cropPdf(src, { crops: [{ page: 2, margins: M(0, 150, 0, 150) }] }));
  check("margins too wide for a page are refused, naming it", /page 3/.test(tooBig.error?.message ?? ""), tooBig.error?.message);
  const none = await settle(cropPdf(src, { crops: [] }));
  check("no pages picked", none.error?.message === "Pick the pages to crop.");
  const missing = await settle(cropPdf(src, { crops: [{ page: 9, margins }] }));
  check("a page the file doesn't have", missing.error?.message === "This PDF has no page 10.");
}

// --- Links, notes and fields: inside stay, wholly outside go -------------------
type Extra = Parameters<typeof makePdf>[1];
/** Pages with links, a note and its popup, and two filled-in fields: one in the middle, one near the top-left. */
async function annotated(specs: Spec[] = [{ size: [600, 800] }, { size: [600, 800] }], more?: Extra) {
  return makePdf(specs, (doc, page, at, i) => {
    const ctx = doc.context;
    const link = (rect: number[], url: string) =>
      ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(url) } }));
    const annots = [link([250, 380, 350, 420], "https://inside.example/"), link([20, 720, 120, 760], "https://outside.example/"), link([60, 300, 160, 340], "https://edge.example/")];
    // A note outside the box, with its popup inside it: both go.
    const note = ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [20, 20, 40, 40], Contents: PDFString.of("outside note") });
    const noteRef = ctx.register(note);
    const popup = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [300, 300, 400, 400], Parent: noteRef }));
    note.set(PDFName.of("Popup"), popup);
    annots.push(noteRef, popup);
    page.node.set(PDFName.of("Annots"), ctx.obj(annots));
    const form = doc.getForm();
    const inside = form.createTextField(`inside${i}`);
    inside.setText("kept value");
    inside.addToPage(page, { x: 220, y: 450, width: 160, height: 24 });
    const outside = form.createTextField(`outside${i}`);
    outside.setText("secret value");
    outside.addToPage(page, { x: 20, y: 600, width: 100, height: 24 });
    more?.(doc, page, at, i);
  });
}
{
  const src = await annotated();
  const { bytes, report } = await cropPdf(src, { crops: [{ page: 0, margins: M(150, 150, 150, 150) }] });
  const r = await read(bytes);
  const [p1, p2] = r.pages;
  const urls = p1.annotations.filter((a) => a.subtype === "Link").map((a) => a.url).sort().join(" ");
  check("links inside or reaching into the box stay; wholly outside go", urls === "https://edge.example/ https://inside.example/", urls);
  check("a note outside goes, and its popup with it", !p1.annotations.some((a) => a.subtype === "Text" || a.subtype === "Popup"), p1.annotations.map((a) => a.subtype));
  check("a field inside stays", p1.annotations.some((a) => a.fieldName === "inside0"));
  check("a field outside goes from the page", !p1.annotations.some((a) => a.fieldName === "outside0"));
  check("the other page keeps all of its own", p2.annotations.length === 7, p2.annotations.map((a) => a.subtype));
  check("the report counts what went", report.removed === 4, report);
  await r.destroy();
  const doc = await PDFDocument.load(bytes);
  const names = doc.getForm().getFields().map((f) => f.getName()).sort().join(" ");
  check("the field outside leaves the form; the rest stay filled in", names === "inside0 inside1 outside1" && doc.getForm().getTextField("inside0").getText() === "kept value", names);
  const named = [...doc.context.enumerateIndirectObjects()].filter(([, o]) => o instanceof PDFDict && o.lookup(PDFName.of("T"))?.toString().includes("outside0"));
  check("the removed field leaves the file, value and all", named.length === 0, named.length);
}

// --- Owner passwords, locked files, broken files, many pages ------------------
{
  const plain = await makePdf([{ size: [600, 800] }]);
  const owner = await SecurePDFDocument.load(plain);
  owner.encrypt({ ownerPassword: "owner-only", userPassword: "", permissions: { printing: "highResolution" } });
  const ownerBytes = await owner.save();
  const ok = await settle(cropPdf(ownerBytes, { crops: [{ page: 0, margins: M(100, 100, 100, 100) }] }));
  const r = ok.value ? await read(ok.value.bytes) : null;
  check("a file with only an owner password is cropped", !!r && near(r.pages[0].width, 400) && shown(r.pages[0]) === "MIDDLE PAGE1", ok.error?.message);
  await r?.destroy();

  const locked = await SecurePDFDocument.load(plain);
  locked.encrypt({ ownerPassword: "o", userPassword: "user" });
  const lockedRun = await settle(cropPdf(await locked.save(), { crops: [{ page: 0, margins: M(10, 10, 10, 10) }] }));
  check("a file that needs a password says to unlock it", lockedRun.error?.message === "This PDF is password-protected. Unlock it first.", lockedRun.error?.message);

  const broken = await settle(cropPdf(new TextEncoder().encode("not a pdf at all"), { crops: [{ page: 0, margins: M(0, 0, 0, 0) }] }));
  check("a file that isn't a PDF", broken.error?.message === "This file isn't a readable PDF.", broken.error?.message);
  const header = await settle(cropPdf(new TextEncoder().encode("%PDF-1.7\n%%EOF\n"), { crops: [{ page: 0, margins: M(0, 0, 0, 0) }] }));
  check("a header with nothing after it", header.error?.message === "This file isn't a readable PDF.", header.error?.message);
  const cut = await settle(cropPdf(plain.slice(0, Math.floor(plain.length / 2)), { crops: [{ page: 0, margins: M(10, 10, 10, 10) }] }));
  check("half a file", !!cut.error && !/line:|offset=|PDFDict/.test(cut.error.message), cut.error?.message);

  const ctl = new AbortController();
  ctl.abort();
  const cancelled = await settle(cropPdf(plain, { crops: [{ page: 0, margins: M(10, 10, 10, 10) }] }, undefined, ctl.signal));
  check("Cancel stops it", cancelled.error?.name === "AbortError");

  const many = await makePdf(Array.from({ length: 600 }, (_, i) => ({ size: (i % 2 ? [842, 595] : [595, 842]) as [number, number], rotate: i % 3 ? 0 : 90 })));
  const t0 = performance.now();
  const ticks: number[] = [];
  const big = await cropPdf(many, { crops: Array.from({ length: 600 }, (_, page) => ({ page, margins: M(20, 20, 20, 20) })) }, (f) => ticks.push(f));
  const ms = performance.now() - t0;
  const bigDoc = await PDFDocument.load(big.bytes);
  check("600 pages: every page cropped", big.report.cropped === 600 && bigDoc.getPageCount() === 600);
  check("600 pages: progress goes up as it works", ticks.length > 10 && ticks.every((t, i) => i === 0 || t >= ticks[i - 1]));
  check("600 pages: under 10 seconds", ms < 10_000, Math.round(ms));
  // The worker wrapper runs here when there are no workers (Node).
  const viaFile = await cropFile(new Blob([plain as Uint8Array<ArrayBuffer>]), { crops: [{ page: 0, margins: M(1, 1, 1, 1) }] });
  check("the worker wrapper runs on this thread without workers", (await PDFDocument.load(viaFile.bytes)).getPages()[0].getWidth() === 598);
}

// --- Remove what's outside: pages rebuilt from a picture of the box ----------
if (!canvasMod) {
  console.log("SKIP  pictures and trimming: node-canvas isn't installed");
} else {
  // Links, a note and fields on each page, a word only the outside of the first two holds, a dark block in the middle, a bookmark and tags.
  const src = await annotated([{ size: [600, 800] }, { size: [500, 700], rotate: 90 }, { size: [600, 800] }], (_doc, page, at, i) => {
    if (i < 2) page.drawText(`EDGEWORD${i}`, { ...at(30, 100), size: 10, rotate: degrees(i === 1 ? 90 : 0) });
    const c = at(250, 300);
    page.drawRectangle({ x: c.x, y: c.y, width: i === 1 ? 40 : 100, height: i === 1 ? 100 : 40, color: rgb(0, 0, 0) });
  });
  const base = await PDFDocument.load(src);
  const ctx = base.context;
  const outline = ctx.obj({ Type: "Outlines" });
  const outlineRef = ctx.register(outline);
  const item = ctx.register(ctx.obj({ Title: PDFString.of("Middle"), Parent: outlineRef, Dest: [base.getPages()[0].ref, PDFName.of("XYZ"), 300, 450, null] }));
  outline.set(PDFName.of("First"), item);
  outline.set(PDFName.of("Last"), item);
  outline.set(PDFName.of("Count"), PDFNumber.of(1));
  base.catalog.set(PDFName.of("Outlines"), outlineRef);
  base.catalog.set(PDFName.of("StructTreeRoot"), ctx.register(ctx.obj({ Type: "StructTreeRoot", K: [] })));
  base.catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
  const withAll = await base.save({ updateFieldAppearances: false });
  check("pictures: the outside words are in the file to begin with", inFile(await rawText(withAll), "EDGEWORD0") && inFile(await rawText(withAll), "EDGEWORD1"));

  const margins = M(150, 150, 150, 150);
  const file = new Blob([withAll as Uint8Array<ArrayBuffer>]);
  const steps: string[] = [];
  const { bytes, report } = await cropDocument(file, { pages: [0, 1], cut: { margins }, remove: { dpi: 100, keepText: true } }, { canvas, progress: (_, label) => steps.push(label) });
  const r = await read(bytes);
  const [a, b, c] = r.pages;
  check("pictures: the page is the size of the box, upright", near(a.width, 300) && near(a.height, 500) && a.rotate === 0, [a.width, a.height, a.rotate]);
  check("pictures: a turned page comes out upright, shown the same way", near(b.width, 400) && near(b.height, 200) && b.rotate === 0, [b.width, b.height, b.rotate]);
  check("pictures: text inside stays searchable", a.items.some((i) => i.str === "MIDDLE") && b.items.some((i) => i.str === "MIDDLE"), [a.items, b.items]);
  const mid = itemAt(a, "MIDDLE");
  check("pictures: searchable text sits where it shows", !!mid && near(mid.x, 300 - 20 - 150, 3) && near(mid.y, 400 - 150, 4), mid);
  check("pictures: text outside is gone from the page", !a.items.some((i) => i.str === "TOPLEFT") && !b.items.some((i) => i.str === "TOPLEFT"));
  check("pictures: the page left alone keeps its words", shown(c) === "LOWRIGHT MIDDLE PAGE3 TOPLEFT", shown(c));
  const raw = await rawText(bytes);
  check("pictures: what was outside is gone from the file itself", !inFile(raw, "EDGEWORD0") && !inFile(raw, "EDGEWORD1"));
  check("pictures: the page left alone keeps its content in the file", inFile(raw, "PAGE3"));
  const urls = a.annotations.filter((x) => x.subtype === "Link").map((x) => x.url).sort().join(" ");
  check("pictures: links inside still work; outside go", urls === "https://edge.example/ https://inside.example/", a.annotations);
  const inside = a.annotations.find((x) => x.url === "https://inside.example/");
  check("pictures: a link moves with its page", !!inside && near(inside.rect[0], 100) && near(inside.rect[1], 230), inside?.rect);
  check("pictures: fields and notes are part of the picture", !a.annotations.some((x) => x.subtype === "Widget" || x.subtype === "Text"), a.annotations.map((x) => x.subtype));
  const doc = await PDFDocument.load(bytes);
  const left = doc.getForm().getFields().map((f) => f.getName()).sort().join(" ");
  check("pictures: the pictured pages' fields leave the form; the other page's stay", left === "inside2 outside2", left);
  check("pictures: the tags go (they described what was removed)", !doc.catalog.get(PDFName.of("StructTreeRoot")) && !doc.catalog.get(PDFName.of("MarkInfo")));
  const dest = await r.destOf(r.outline[0]?.dest);
  check("pictures: a bookmark to the page lands on the same spot", dest.page === 1 && near(dest.args[1] as number, 150) && near(dest.args[2] as number, 300), dest);
  check("pictures: the report", report.cropped === 2 && report.pictured === 2, report);
  check("pictures: progress says what it's doing", steps.some((s) => /Drawing page 1/.test(s)) && steps.some((s) => /Saving/.test(s)), steps);
  await r.destroy();

  // The picture itself: the dark block in the middle, where it was.
  const pic = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, standardFontDataUrl: FONTS }).promise;
  const pg = await pic.getPage(1);
  const vp = pg.getViewport({ scale: 1 });
  const cv = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const cx = cv.getContext("2d");
  await pg.render({ canvasContext: cx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const px = (u: number, v: number) => Array.from(cx.getImageData(u, v, 1, 1).data.slice(0, 3));
  // On page 1 the block sits at 250..350 from the left, 460..500 from the top; less the margins.
  const dark = px(150, 330);
  const light = px(20, 20);
  check("pictures: the picture shows what was inside the box, in place", dark.every((v) => v < 90) && light.every((v) => v > 200), { dark, light });
  // The field inside sits 70..230 from the left and 176..200 from the top of the box. Its frame is
  // drawn only when fields are drawn into the picture. (Its words need fonts pdf.js has no files for
  // in Node; the browser draws them.)
  let inked = 0;
  for (let u = 80; u < 220; u++) for (let v = 174; v < 179; v++) if (px(u, v)[0] < 160) inked++;
  check("pictures: a field inside is drawn into the picture", inked > 100, inked);
  await pic.destroy();

  const keepNone = await cropDocument(file, { pages: [2], cut: { margins }, remove: { dpi: 72, keepText: false } }, { canvas });
  const rn = await read(keepNone.bytes);
  check("pictures without text: nothing to search on that page, links still there", rn.pages[2].items.length === 0 && rn.pages[2].annotations.every((x) => x.subtype === "Link"), rn.pages[2].annotations);
  await rn.destroy();
  const { pictureAreas } = await import("../lib/pdf/crop/pictures.ts");
  const pdf = await loadForRender(withAll);
  const tooMany = await settle(pictureAreas(pdf, [0, 1, 2].map((page) => ({ page, margins: M(0, 0, 0, 0) })), { dpi: 300, keepText: false, canvas, maxPixels: 5_000_000 }));
  check("pictures: more pixels than a tab can hold are refused before drawing", tooMany.error?.message === "These pages are too big to turn into pictures here.", tooMany.error?.message);
  pdf.destroy();

  // --- Trim white margins ---------------------------------------------------
  const tdoc = await PDFDocument.create();
  const p1 = tdoc.addPage([600, 800]);
  p1.drawRectangle({ x: 100, y: 200, width: 300, height: 400, color: rgb(0.2, 0.2, 0.2) });
  tdoc.addPage([600, 800]); // blank
  const p3 = tdoc.addPage([400, 600]);
  p3.setRotation(degrees(90));
  p3.drawRectangle({ x: 50, y: 100, width: 100, height: 200, color: rgb(0, 0, 0.6) });
  const trimSrc = await tdoc.save();
  const loaded = await loadForRender(trimSrc);
  const found = await findMargins(loaded, [0, 1, 2], { padding: 6, canvas });
  const f1 = found.get(0);
  check("trim: the content's edges are found, with the padding", !!f1 && near(f1.left, 94, 2) && near(f1.right, 194, 2) && near(f1.top, 194, 2) && near(f1.bottom, 194, 2), f1);
  check("trim: a blank page is left as it is", found.get(1) === null);
  const f3 = found.get(2);
  // Turned 90: shown 600 wide, 400 tall; the block sits 100..300 from the left, 50..150 from the top.
  check("trim: a turned page is measured as shown", !!f3 && near(f3.left, 94, 2) && near(f3.top, 44, 2) && near(f3.right, 600 - 306, 2) && near(f3.bottom, 400 - 156, 2), f3);
  loaded.destroy();
  const trimmed = await cropDocument(new Blob([trimSrc as Uint8Array<ArrayBuffer>]), { pages: [0, 1, 2], cut: { trim: { padding: 6 } } }, { canvas });
  const tr = await read(trimmed.bytes);
  const tsizes = tr.pages.map((p) => [p.width, p.height]);
  const want = [[312, 412], [600, 800], [212, 112]];
  check("trim: each page cut to its own content; the blank one stays", tsizes.every((s, i) => near(s[0], want[i][0], 2) && near(s[1], want[i][1], 2)), tsizes);
  check("trim: blank pages are counted as skipped", trimmed.skipped === 1 && trimmed.report.cropped === 2, trimmed);
  await tr.destroy();
  const known = await cropDocument(new Blob([trimSrc as Uint8Array<ArrayBuffer>]), { pages: [0], cut: { trim: { padding: 6 } }, found: new Map([[0, M(10, 10, 10, 10)]]) }, { canvas });
  check("trim: margins the preview found are used as they are", (await PDFDocument.load(known.bytes)).getPages()[0].getWidth() === 580);
  const nothing = await settle(cropDocument(new Blob([trimSrc as Uint8Array<ArrayBuffer>]), { pages: [1], cut: { trim: { padding: 6 } } }, { canvas }));
  check("trim: nothing to trim says so", nothing.error instanceof NothingToTrimError && nothing.error.message === "No white margins to trim on these pages.", nothing.error?.message);
  const ctl = new AbortController();
  ctl.abort();
  const stopped = await settle(cropDocument(new Blob([trimSrc as Uint8Array<ArrayBuffer>]), { pages: [0, 2], cut: { trim: { padding: 6 } } }, { canvas, signal: ctl.signal }));
  check("trim: Cancel stops it", stopped.error?.name === "AbortError", stopped.error?.message);
  const lockedTrim = await SecurePDFDocument.load(trimSrc);
  lockedTrim.encrypt({ ownerPassword: "o", userPassword: "user" });
  const lockedRun = await settle(cropDocument(new Blob([(await lockedTrim.save()) as Uint8Array<ArrayBuffer>]), { pages: [0], cut: { trim: { padding: 6 } } }, { canvas }));
  check("trim: a locked file says to unlock it", lockedRun.error?.message === "This PDF is password-protected. Unlock it first.", lockedRun.error?.message);
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
