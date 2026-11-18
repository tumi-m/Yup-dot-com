// Images to PDF beyond JPG and PNG: formats told apart by their bytes, a
// TIFF's every page (and only its pages, not its previews) on its own page,
// TIFF orientation kept, damaged and looping TIFFs turned away, decoded
// pictures right-sized with transparency kept, mixed batches in order, the
// HEIC message where a browser can't read it, and the pages' file pickers.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
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

const { sniffFormat, svgSize, acceptFor, ALL_FORMATS, HEIC_MESSAGE } = await import("../lib/pdf/images-to-pdf/formats.ts");
const { sizeSvg, canvasFit, decodeBitmap, dropForeignObjects } = await import("../lib/pdf/images-to-pdf/decode.ts");
const { tiffDirectories } = await import("../lib/pdf/images-to-pdf/tiff.ts");
const { imagesToPdf } = await import("../lib/pdf/images-to-pdf/index.ts");
const { imagesToPdfTool } = await import("../lib/pdf/toolkit.ts");
const { takesFile } = await import("../components/tools/file-pick.ts");
const { PROCESSORS } = await import("../components/tools/processors.ts");
type Frame = import("../lib/pdf/images-to-pdf/decode.ts").Frame;

const file = (bytes: Uint8Array | string, name: string, type = "") =>
  new File([typeof bytes === "string" ? bytes : (bytes.slice() as unknown as BlobPart)], name, { type });
const fit = { pageSize: "fit", margin: "0" };
const sizes = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getSize()).map((s) => `${Math.round(s.width)}x${Math.round(s.height)}`);

/** The image XObjects in a PDF (not their soft masks), with whether each has a mask. */
async function images(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const out: { width: number; height: number; filter: string; masked: boolean }[] = [];
  const masks = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const sm = obj instanceof PDFRawStream ? obj.dict.get(PDFName.of("SMask")) : undefined;
    if (sm) masks.add(sm.toString());
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image") || masks.has(ref.toString())) continue;
    const n = (k: string) => (obj.dict.get(PDFName.of(k)) as PDFNumber).asNumber();
    out.push({ width: n("Width"), height: n("Height"), filter: String(obj.dict.get(PDFName.of("Filter"))), masked: !!obj.dict.get(PDFName.of("SMask")) });
  }
  return out;
}

/** pdf.js's picture of a page, as a reader shows it; null without node-canvas. */
async function render(bytes: Uint8Array, pageNo: number) {
  if (!canvasMod) return null;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  const canvas = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  await doc.destroy();
  return { width: canvas.width, height: canvas.height, at: (x: number, y: number) => [...data.subarray((y * canvas.width + x) * 4, (y * canvas.width + x) * 4 + 3)] };
}
const near = (a: number[] | undefined, b: number[], tol = 40) => !!a && a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ---------------------------------------------------------------------------
// A small TIFF writer: uncompressed strips, any number of pages.
// ---------------------------------------------------------------------------
interface TiffPage {
  width: number;
  height: number;
  /** 3: RGB, 1: grey, "bilevel": 1 bit, black is zero. */
  kind: 3 | 1 | "bilevel";
  pixel: (x: number, y: number) => number[];
  orientation?: number;
  /** NewSubfileType 1: a reduced-size copy of another page. */
  preview?: boolean;
}

function tiff(pages: TiffPage[], little = true): Uint8Array {
  const parts: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  const put16 = (at: number, v: number) => {
    if (little) [parts[at], parts[at + 1]] = [v & 255, v >> 8];
    else [parts[at], parts[at + 1]] = [v >> 8, v & 255];
  };
  const put32 = (at: number, v: number) => {
    const b = [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24];
    for (let i = 0; i < 4; i++) parts[at + i] = little ? b[i] : b[3 - i];
  };
  const pad = () => {
    while (parts.length % 2) parts.push(0);
  };
  if (little) parts.splice(0, 4, 0x49, 0x49, 42, 0);
  else parts.splice(0, 4, 0x4d, 0x4d, 0, 42);
  let link = 4;
  for (const page of pages) {
    // Pixel data first.
    const dataAt = parts.length;
    for (let y = 0; y < page.height; y++) {
      if (page.kind === "bilevel") {
        const row = new Array(Math.ceil(page.width / 8)).fill(0);
        for (let x = 0; x < page.width; x++) if (page.pixel(x, y)[0] > 127) row[x >> 3] |= 0x80 >> (x & 7);
        parts.push(...row);
      } else {
        for (let x = 0; x < page.width; x++) parts.push(...page.pixel(x, y).slice(0, page.kind));
      }
    }
    const dataLength = parts.length - dataAt;
    pad();
    const bpsAt = parts.length;
    if (page.kind === 3) parts.push(0, 0, 0, 0, 0, 0);
    if (page.kind === 3) for (let i = 0; i < 3; i++) put16(bpsAt + i * 2, 8);
    pad();
    const tags: [number, number, number, number][] = [
      [254, 4, 1, page.preview ? 1 : 0],
      [256, 4, 1, page.width],
      [257, 4, 1, page.height],
      [258, 3, page.kind === 3 ? 3 : 1, page.kind === 3 ? bpsAt : page.kind === "bilevel" ? 1 : 8],
      [259, 3, 1, 1],
      [262, 3, 1, page.kind === 3 ? 2 : 1],
      [273, 4, 1, dataAt],
      ...(page.orientation ? ([[274, 3, 1, page.orientation]] as [number, number, number, number][]) : []),
      [277, 3, 1, page.kind === 3 ? 3 : 1],
      [278, 4, 1, page.height],
      [279, 4, 1, dataLength],
    ];
    const ifd = parts.length;
    put32(link, ifd);
    parts.length += 2 + tags.length * 12 + 4;
    parts.fill(0, ifd);
    put16(ifd, tags.length);
    tags.forEach(([tag, type, count, value], i) => {
      const e = ifd + 2 + i * 12;
      put16(e, tag);
      put16(e + 2, type);
      put32(e + 4, count);
      // A single SHORT sits in the first two bytes of the value field.
      if (type === 3 && count === 1) put16(e + 8, value);
      else put32(e + 8, value);
    });
    link = ifd + 2 + tags.length * 12;
  }
  return new Uint8Array(parts);
}

// ---------------------------------------------------------------------------
// Formats by their bytes
// ---------------------------------------------------------------------------
{
  const enc = (s: string) => new TextEncoder().encode(s);
  const ftyp = (major: string, ...compat: string[]) => {
    const body = enc(`ftyp${major}\0\0\0\0${compat.join("")}`);
    const out = new Uint8Array(4 + body.length + 8);
    new DataView(out.buffer).setUint32(0, 4 + body.length);
    out.set(body, 4);
    return out;
  };
  const cases: [string, Uint8Array, string | null][] = [
    ["png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "png"],
    ["jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "jpeg"],
    ["gif", enc("GIF89a\x01\x00\x01\x00"), "gif"],
    ["webp", enc("RIFF\x10\x00\x00\x00WEBPVP8 "), "webp"],
    ["bmp", new Uint8Array([0x42, 0x4d, ...new Array(30).fill(0)]), "bmp"],
    ["tiff (II)", tiff([{ width: 1, height: 1, kind: 1, pixel: () => [0] }]), "tiff"],
    ["tiff (MM)", tiff([{ width: 1, height: 1, kind: 1, pixel: () => [0] }], false), "tiff"],
    ["avif", ftyp("avif", "mif1", "miaf"), "avif"],
    ["avif listed after mif1", ftyp("mif1", "avif"), "avif"],
    ["heic", ftyp("heic", "mif1", "heic"), "heic"],
    ["heif (mif1)", ftyp("mif1", "heic"), "heic"],
    ["mp4 is not a picture", ftyp("isom", "mp41"), null],
    ["svg", enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), "svg"],
    ["svg after a declaration, comment and doctype", enc('﻿<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg width="1">'), "svg"],
    ["html with an svg inside is not an svg", enc("<html><svg></svg></html>"), null],
    ["a PDF", enc("%PDF-1.7\n"), null],
    ["empty", new Uint8Array(0), null],
  ];
  for (const [name, bytes, want] of cases) check(`sniff: ${name}`, sniffFormat(bytes) === want, sniffFormat(bytes));
}

// ---------------------------------------------------------------------------
// SVG sizes
// ---------------------------------------------------------------------------
{
  const s = (root: string) => svgSize(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" ${root}><rect/></svg>`);
  check("svg: width and height in px", JSON.stringify(s('width="200" height="100px"')) === '{"width":200,"height":100}', s('width="200" height="100px"'));
  check("svg: inches and mm become CSS pixels", JSON.stringify(s('width="2in" height="25.4mm"')) === '{"width":192,"height":96}', s('width="2in" height="25.4mm"'));
  check("svg: viewBox alone gives the shape", JSON.stringify(s('viewBox="0 0 24 12"')) === '{"width":24,"height":12}');
  check("svg: width and a viewBox give the height", JSON.stringify(s("width='300' viewBox='0,0,30,10'")) === '{"width":300,"height":100}', s("width='300' viewBox='0,0,30,10'"));
  check("svg: percentages fall back to the viewBox", JSON.stringify(s('width="100%" height="100%" viewBox="0 0 50 40"')) === '{"width":50,"height":40}');
  check("svg: no size at all is null", s("") === null);
  const resized = sizeSvg('<svg width="10" height="5" class="x"><g/></svg>', { width: 10, height: 5 }, { width: 400, height: 200 });
  check("svg: drawn at print size with a viewBox added", resized === '<svg width="400" height="200" viewBox="0 0 10 5" class="x"><g/></svg>', resized);
  // HTML inside an SVG (diagram labels) would make the browser refuse to hand back any pixels.
  const fo = dropForeignObjects('<svg><rect/><switch><foreignObject x="1" y=\'2\' requiredFeatures="a>b"><div xmlns="http://www.w3.org/1999/xhtml"><svg><foreignObject/><foreignObject><p>in</p></foreignObject></svg>Label</div></foreignObject><text>Label</text></switch><svg:foreignObject/></svg>');
  check("svg: foreignObject parts go, the fallback text stays", fo === "<svg><rect/><switch><text>Label</text></switch></svg>", fo);
  check("svg: an SVG without them is untouched", dropForeignObjects('<svg><g id="foreignObjects"/></svg>') === '<svg><g id="foreignObjects"/></svg>');
  const kept = sizeSvg("<svg viewBox='0 0 1 1' width='1in'>", { width: 96, height: 96 }, { width: 4096, height: 4096 });
  check("svg: its own viewBox is kept", kept === `<svg width="4096" height="4096" viewBox='0 0 1 1'>`, kept);
  const big = canvasFit(8000, 6000);
  check("decode: a 48 MP picture is drawn at 16.7 MP or less, same shape", big.width * big.height <= 4096 * 4096 && Math.abs(big.width / big.height - 4 / 3) < 0.01, big);
}

// ---------------------------------------------------------------------------
// TIFF: pages, previews, orientation, damage
// ---------------------------------------------------------------------------
const halves = (w: number) => (x: number) => (x < w / 2 ? [220, 30, 30] : [30, 30, 220]);
const multi = tiff([
  { width: 40, height: 20, kind: 3, pixel: halves(40) },
  // Stored 30 wide, 60 tall, dark at the top; orientation 6 shows it turned a quarter clockwise.
  { width: 30, height: 60, kind: 1, pixel: (_x, y) => [y < 30 ? 20 : 235], orientation: 6 },
  { width: 10, height: 5, kind: 3, pixel: () => [0, 255, 0], preview: true },
  { width: 64, height: 16, kind: "bilevel", pixel: (x) => [x < 32 ? 0 : 255] },
]);
{
  const dirs = tiffDirectories(multi);
  check("tiff: four directories found", dirs?.length === 4, dirs);
  const out = await imagesToPdf([file(multi, "scan.tiff", "image/tiff")], fit);
  const got = await sizes(out);
  check("tiff: a PDF page per TIFF page, the preview left out", got.join() === "40x20,60x30,64x16", got);
  const pic = await render(out, 1);
  if (pic) {
    check("tiff: page 1 colours (left red, right blue)", near(pic.at(5, 10), [220, 30, 30]) && near(pic.at(35, 10), [30, 30, 220]), [pic.at(5, 10), pic.at(35, 10)]);
    const turned = (await render(out, 2))!;
    // Turned clockwise, the stored top (dark) is on the right.
    check("tiff: orientation 6 is applied (dark side on the right)", near(turned.at(55, 15), [20, 20, 20]) && near(turned.at(5, 15), [235, 235, 235]), [turned.at(55, 15), turned.at(5, 15)]);
    const fax = (await render(out, 3))!;
    check("tiff: 1-bit page (black left, white right)", near(fax.at(8, 8), [0, 0, 0]) && near(fax.at(56, 8), [255, 255, 255]), [fax.at(8, 8), fax.at(56, 8)]);
  } else console.log("SKIP  tiff renders (node-canvas not installed)");

  const be = await imagesToPdf([file(tiff([{ width: 12, height: 7, kind: 3, pixel: () => [10, 200, 10] }], false), "mac.tif")], fit);
  check("tiff: big-endian file converts", (await sizes(be)).join() === "12x7");

  // The UTIF writer's own TIFF reads back too.
  const { default: UTIF } = (await import("utif2")) as unknown as { default: typeof import("utif2") };
  const rgba = new Uint8Array(9 * 4 * 4).fill(255);
  const made = new Uint8Array(UTIF.encodeImage(rgba, 9, 4));
  check("tiff: a file from another writer converts", (await sizes(await imagesToPdf([file(made, "other.tiff")], fit))).join() === "9x4");

  // A chain that loops back to its own first page: one page, no hang.
  const loop = tiff([{ width: 5, height: 5, kind: 1, pixel: () => [128] }]);
  const first = new DataView(loop.buffer).getUint32(4, true);
  const count = new DataView(loop.buffer).getUint16(first, true);
  new DataView(loop.buffer).setUint32(first + 2 + count * 12, first, true);
  const looped = await Promise.race([settle(imagesToPdf([file(loop, "loop.tiff")], fit)), new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  check("tiff: a looping page chain makes one page and ends", typeof looped === "object" && !!(looped as { value: Uint8Array | null }).value, looped);

  // A field claiming 4 billion values: turned away before UTIF reads it.
  const lying = tiff([{ width: 5, height: 5, kind: 1, pixel: () => [128] }]);
  const ifd = new DataView(lying.buffer).getUint32(4, true);
  new DataView(lying.buffer).setUint32(ifd + 2 + 3 * 12 + 4, 0xffffffff, true);
  const lie = await settle(imagesToPdf([file(lying, "huge-count.tiff")], fit));
  check("tiff: a count past the end of the file is damaged", lie.error?.message === "huge-count.tiff: this image looks damaged.", lie.error?.message);

  const cut = await settle(imagesToPdf([file(multi.slice(0, 12), "cut.tiff")], fit));
  check("tiff: a cut-off file is damaged", cut.error?.message === "cut.tiff: this image looks damaged.", cut.error?.message);

  // Data that isn't in the file: refused, not drawn blank (UTIF reads zeros past the end).
  const away = tiff([{ width: 5, height: 5, kind: 1, pixel: () => [128] }]);
  const ai = new DataView(away.buffer).getUint32(4, true);
  new DataView(away.buffer).setUint32(ai + 2 + 6 * 12 + 8, 999999, true);
  const gone = await settle(imagesToPdf([file(away, "strip-away.tiff")], fit));
  check("tiff: strip data past the end of the file is damaged", gone.error?.message === "strip-away.tiff: this image looks damaged.", gone.error?.message);
  // 49.9 MP claimed with 25 bytes of uncompressed data behind it.
  const thin = tiff([{ width: 5, height: 5, kind: 1, pixel: () => [128] }]);
  const ti = new DataView(thin.buffer).getUint32(4, true);
  new DataView(thin.buffer).setUint32(ti + 2 + 1 * 12 + 8, 7000, true);
  new DataView(thin.buffer).setUint32(ti + 2 + 2 * 12 + 8, 7128, true);
  const short = await settle(imagesToPdf([file(thin, "short.tiff")], fit));
  check("tiff: too little data for the page's size is damaged", short.error?.message === "short.tiff: this image looks damaged.", short.error?.message);

  // A 60 MP page is refused before decoding.
  const giant = tiff([{ width: 1, height: 1, kind: 1, pixel: () => [0] }]);
  const gi = new DataView(giant.buffer).getUint32(4, true);
  new DataView(giant.buffer).setUint32(gi + 2 + 1 * 12 + 8, 10000, true);
  new DataView(giant.buffer).setUint32(gi + 2 + 2 * 12 + 8, 6000, true);
  const tooBig = await settle(imagesToPdf([file(giant, "poster.tiff")], fit));
  check("tiff: a page over 50 MP is refused", tooBig.error?.message === "poster.tiff: this image is too large to convert on this device.", tooBig.error?.message);
}

// ---------------------------------------------------------------------------
// Decoded formats (the browser's decoders stand in a fake here)
// ---------------------------------------------------------------------------
const frame = (w: number, h: number, rgba: (x: number, y: number) => number[], size = { width: w, height: h }): Frame => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(rgba(x, y), (y * w + x) * 4);
  return { pixels: { data, width: w, height: h }, width: size.width, height: size.height, orientation: 1 };
};
{
  const asked: string[] = [];
  const fake = async (_bytes: Uint8Array, format: string, name: string) => {
    asked.push(`${name}:${format}`);
    // A transparent logo: a red square on nothing.
    if (format === "webp") return frame(80, 40, (x, y) => (x > 20 && x < 60 && y > 10 && y < 30 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    // A drawn SVG: 400 x 200 pixels for a 100 x 50 graphic.
    if (format === "svg") return frame(400, 200, (x) => (x < 200 ? [0, 0, 0, 255] : [255, 255, 255, 255]), { width: 100, height: 50 });
    return frame(16, 16, () => [90, 90, 90, 255]);
  };
  const enc = (s: string) => new TextEncoder().encode(s);
  const jpeg = await codec.encodeJpeg({ data: new Uint8ClampedArray(30 * 10 * 4).fill(128), width: 30, height: 10 }, { quality: 90 });
  const inputs = [
    file(enc("RIFF\x10\x00\x00\x00WEBPVP8 "), "logo.webp", "image/webp"),
    file(jpeg, "photo.jpg", "image/jpeg"),
    file(enc('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>'), "chart.svg", "image/svg+xml"),
    file(multi, "scan.tif", ""),
    file(enc("GIF89a\x01\x00\x01\x00"), "anim.gif", "image/gif"),
  ];
  const progress: string[] = [];
  const out = await imagesToPdf(inputs, fit, (_f, label) => progress.push(label), undefined, fake);
  const got = await sizes(out);
  check("mixed batch: every file in order, a TIFF's three pages among them", got.join() === "80x40,30x10,100x50,40x20,60x30,64x16,16x16", got);
  // Sizes only an SVG reaches: a fraction of a point, or a hairline a million wide.
  const odd = async (width: number, height: number) => {
    const bytes = await imagesToPdf([file(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), "odd.svg", "image/svg+xml")], fit, undefined, undefined, async () => frame(4, 4, () => [0, 0, 0, 255], { width, height }));
    return (await PDFDocument.load(bytes)).getPage(0).getSize();
  };
  const tiny = await odd(0.001, 0.001);
  const wide = await odd(1_000_000, 1);
  check("fit: a picture a fraction of a point across gets the smallest page", tiny.width === 3 && tiny.height === 3, tiny);
  check("fit: a hairline gets a page at least 3 points tall", wide.width === 14400 && wide.height === 3, wide);
  check("mixed batch: only the formats that need it go to the decoder", asked.join() === "logo.webp:webp,chart.svg:svg,anim.gif:gif", asked);
  check("mixed batch: progress names the image and the TIFF page", progress.includes("Image 4 of 5, page 2 of 3"), progress);
  const imgs = await images(out);
  check("decoded: transparency kept as a soft mask", imgs[0].masked && imgs[0].filter === "/FlateDecode", imgs[0]);
  check("decoded: a JPEG is still embedded as a JPEG", imgs[1].filter === "/DCTDecode", imgs[1]);
  check("decoded: a drawn SVG keeps its raster on a page its own size", imgs[2].width === 400 && imgs[2].height === 200, imgs[2]);
  const pic = await render(out, 1);
  if (pic) check("decoded: the logo's clear areas show the white page", near(pic.at(2, 2), [255, 255, 255], 5) && near(pic.at(40, 20), [255, 0, 0]), [pic.at(2, 2), pic.at(40, 20)]);

  // A4 with a margin: the picture fits inside it, centred. A wide one gets a landscape sheet.
  const a4 = await imagesToPdf([file(enc("RIFF\x10\x00\x00\x00WEBPVP8 "), "wide.webp")], { pageSize: "a4", margin: "48" }, undefined, undefined, fake);
  check("a4: one landscape A4 page for a wide picture", (await sizes(a4)).join() === "842x595", await sizes(a4));
  // Where pdf.js finds the picture drawn: its transform before the paint.
  const doc = await pdfjs.getDocument({ data: a4.slice(), isEvalSupported: false }).promise;
  const list = await (await doc.getPage(1)).getOperatorList();
  const at = list.fnArray.indexOf(pdfjs.OPS.paintImageXObject);
  // The transforms since the last save, multiplied together (translate, then scale, …).
  let m = [1, 0, 0, 1, 0, 0];
  for (let i = list.fnArray.slice(0, at).lastIndexOf(pdfjs.OPS.save) + 1; i < at; i++) {
    if (list.fnArray[i] !== pdfjs.OPS.transform) continue;
    const [a, b, c, d, e, f] = list.argsArray[i] as number[];
    m = [a * m[0] + b * m[2], a * m[1] + b * m[3], c * m[0] + d * m[2], c * m[1] + d * m[3], e * m[0] + f * m[2] + m[4], e * m[1] + f * m[3] + m[5]];
  }
  const [w, , , h, x, y] = m;
  await doc.destroy();
  check("a4: drawn 746 pt wide between the margins, centred", Math.abs(w - 745.89) < 0.1 && Math.abs(x - 48) < 0.1 && Math.abs(y - (595.28 - h) / 2) < 0.1, [w, h, x, y]);
  const tall = await imagesToPdf([file(enc("RIFF\x10\x00\x00\x00WEBPVP8 "), "tall.webp")], { pageSize: "a4", margin: "0" }, undefined, undefined, async () => frame(40, 80, () => [0, 0, 255, 255]));
  check("a4: a tall picture keeps a portrait sheet", (await sizes(tall)).join() === "595x842", await sizes(tall));

  // A big photo: right-sized for print on its page.
  let wanted: { width: number; height: number } | null = null;
  const huge = await imagesToPdf([file(enc("RIFF\x10\x00\x00\x00WEBPVP8 "), "big.webp")], { pageSize: "a4", margin: "0" }, undefined, undefined, async (_b, _f, _n, want) => {
    wanted = want?.(4000, 3000) ?? null;
    return frame(4000, 3000, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * y) % 256, 255]);
  });
  const [bigImg] = await images(huge);
  check("right-sized: a 12 MP picture on A4 is stored at about 300 DPI", bigImg.width < 4000 && bigImg.width >= 2400, bigImg);
  check("right-sized: the decoder is asked for only the pixels landscape A4 needs (2480 high at 300 DPI)", !!wanted && Math.abs(wanted!.height - 2480) <= 2 && Math.abs(wanted!.width - 3307) <= 2, wanted);
  // Fit to image follows JPG to PDF's rules for every format: a wide photo is
  // sized for one A4 sheet, a long strip keeps every pixel.
  const { wantFor } = await import("../lib/pdf/images-to-pdf/index.ts");
  const fitWant = wantFor({ pageSize: "fit", margin: "0" });
  const photo = fitWant(4000, 3000);
  check("fit: a wide photo is sized for one A4 sheet (3508 wide at 300 DPI)", !!photo && Math.abs(photo.width - 3508) <= 2, photo);
  // No smaller size asked for: the strip is decoded whole.
  check("fit: a long strip keeps every pixel", fitWant(1080, 20000) === null, fitWant(1080, 20000));
  check("right-sized: a lossy photo goes in as a JPEG", bigImg.filter === "/DCTDecode", bigImg.filter);

  const ctl = new AbortController();
  ctl.abort();
  const stopped = await settle(imagesToPdf(inputs, fit, undefined, ctl.signal, fake));
  check("cancel: stops with an AbortError", stopped.error?.name === "AbortError", stopped.error?.name);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
{
  const notPicture = await settle(imagesToPdfTool([file("%PDF-1.7\n1 0 obj", "report.png", "image/png")], fit));
  check("a PDF named .png explains itself", notPicture.error?.message === "report.png: use a JPG, PNG, WebP, GIF, BMP, TIFF, AVIF, HEIC or SVG image.", notPicture.error?.message);
  const empty = await settle(imagesToPdfTool([file("", "empty.jpg", "image/jpeg")], fit));
  check("an empty file explains itself", empty.error?.message?.startsWith("empty.jpg: use a JPG") === true, empty.error?.message);
  const badPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const damaged = await settle(imagesToPdfTool([file(badPng, "broken.png", "image/png")], fit));
  check("a cut-off PNG is damaged", damaged.error?.message === "broken.png: this image looks damaged.", damaged.error?.message);
  const nodeOnly = await settle(imagesToPdfTool([file("RIFF\x10\x00\x00\x00WEBPVP8 ", "a.webp")], fit));
  check("without a browser decoder: says so, by name", nodeOnly.error?.message === "a.webp: WebP images can't be opened here.", nodeOnly.error?.message);

  // A browser that can't read HEIC (anything but Safari) gets the way out.
  const g = globalThis as Record<string, unknown>;
  const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };
  g.OffscreenCanvas = class {};
  g.createImageBitmap = async () => {
    throw new DOMException("The source image could not be decoded.", "InvalidStateError");
  };
  const heic = await settle(decodeBitmap(new Uint8Array(20), "heic", "IMG_0001.HEIC"));
  check("heic: a browser that can't decode it says how to get a JPG", heic.error?.message === `IMG_0001.HEIC: ${HEIC_MESSAGE}`, heic.error?.message);
  const webp = await settle(decodeBitmap(new Uint8Array(20), "webp", "x.webp"));
  check("webp the browser can't decode is damaged", webp.error?.message === "x.webp: this image looks damaged.", webp.error?.message);

  // A picture larger than a phone's canvas is shrunk by the browser first.
  const resized: unknown[] = [];
  g.createImageBitmap = async (src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
    if (opts?.resizeWidth) resized.push([opts.resizeWidth, opts.resizeHeight]);
    return { width: opts?.resizeWidth ?? 9000, height: opts?.resizeHeight ?? 6000, close() {} };
  };
  g.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      const { width, height } = this;
      return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4) }) };
    }
  };
  const shrunk = await decodeBitmap(new Uint8Array(20), "avif", "big.avif");
  const [rw, rh] = (resized[0] as number[]) ?? [];
  check("decode: a 54 MP AVIF is asked for at 16.7 MP or less", rw * rh <= 4096 * 4096 && shrunk.pixels.width === rw, resized);
  check("decode: the page keeps the picture's full size for layout", shrunk.width === 9000 && shrunk.height === 6000, [shrunk.width, shrunk.height]);
  Object.assign(g, saved);
}

// ---------------------------------------------------------------------------
// The pages' file pickers
// ---------------------------------------------------------------------------
{
  const accepts = (slug: string, name: string, type = "") => {
    const p = PROCESSORS[slug];
    return takesFile(p.alsoAccepts ? `${p.accept},${p.alsoAccepts}` : p.accept, { name, type });
  };
  check("pickers: each page offers its own format", PROCESSORS["heic-to-pdf"].accept.includes(".heic") && !PROCESSORS["heic-to-pdf"].accept.includes("image/png") && PROCESSORS["png-to-pdf"].accept === "image/png,.png");
  check("pickers: JPG to PDF offers every format", ALL_FORMATS.every((f) => PROCESSORS["jpg-to-pdf"].accept.includes(acceptFor([f]).split(",")[0])));
  check("pickers: an iPhone photo with no type is taken by name", accepts("heic-to-pdf", "IMG_0001.HEIC") && accepts("jpg-to-pdf", "IMG_0001.heic"));
  check("pickers: a JPG dropped on PNG to PDF is still taken", accepts("png-to-pdf", "photo.jpg", "image/jpeg"));
  check("pickers: a .tif with an octet-stream type is taken", accepts("tiff-to-pdf", "fax.tif", "application/octet-stream"));
  check("pickers: a PDF is not a picture", !accepts("jpg-to-pdf", "doc.pdf", "application/pdf"));
  check("pickers: a PDF tool still takes an untyped .pdf", takesFile("application/pdf", { name: "x.PDF", type: "" }));
  check("pickers: a PDF tool turns a picture away", !takesFile("application/pdf", { name: "x.png", type: "image/png" }));
  check("pickers: video by name when untyped", takesFile("video/mp4,video/quicktime", { name: "clip.MOV", type: "" }));
  const { looksHeic } = await import("../lib/pdf/images-to-pdf/formats.ts");
  check("heic: the HEIC page checks the browser before a file is picked", PROCESSORS["heic-to-pdf"].needs === "heic" && !PROCESSORS["jpg-to-pdf"].needs);
  check("heic: known by name or type before reading", looksHeic({ name: "IMG_1.HEIC", type: "" }) && looksHeic({ name: "x", type: "image/heif" }) && !looksHeic({ name: "a.jpg", type: "image/jpeg" }));
  {
    // The sample the check opens is a real HEIC (Safari decodes it; there's no HEIC decoder here).
    const src = readFileSync("lib/pdf/images-to-pdf/heic-check.ts", "utf8");
    const sample = Uint8Array.from(Buffer.from(/SAMPLE =\s*"([^"]+)"/.exec(src)![1], "base64"));
    check("heic: the check's sample reads as HEIC", sniffFormat(sample) === "heic" && sample.length < 600, sample.length);
  }
  check("pickers: a typed JPEG named oddly is still taken by type", takesFile("image/jpeg,image/png", { name: "download", type: "image/jpeg" }));
}

// ---------------------------------------------------------------------------
// The pages exist, are listed, and each has its own copy
// ---------------------------------------------------------------------------
{
  const { TOOLS } = await import("../lib/tools.tsx");
  const { CONVERT_COPY } = await import("../components/tools/convert-copy.ts");
  const { panelSpec } = await import("../components/tools/panel-spec.tsx");
  const slugs = ["jpg-to-pdf", "png-to-pdf", "webp-to-pdf", "heic-to-pdf", "tiff-to-pdf", "svg-to-pdf", "txt-to-pdf", "markdown-to-pdf"];
  for (const slug of slugs) {
    const tool = TOOLS.find((t) => t.slug === slug);
    check(`${slug}: listed, a workbench with a processor, its own questions`, !!tool && tool.category === "convert" && panelSpec(tool).kind === "workbench" && !!PROCESSORS[slug] && (CONVERT_COPY[slug]?.faq.length ?? 0) >= 2);
  }
  const titles = slugs.map((s) => TOOLS.find((t) => t.slug === s)!.title);
  check("each page has its own title", new Set(titles).size === slugs.length, titles);
  check("no slug is listed twice", new Set(TOOLS.map((t) => t.slug)).size === TOOLS.length);
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
