process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// Edit PDF: a phone photo (pixels stored sideways, EXIF orientation 6) shows
// upright in the editor, so the exported PDF must draw it upright too, the
// same shape, and right-sized for the box it fills.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { RawImage } from "../lib/image-codec.ts";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { jpegOrientation } from "../lib/pdf/images.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Loaded dynamically, so the wasm reaches the copy the app modules use.
const { encodeJpeg, useJpegWasm } = await import("../lib/image-codec.ts");
const codec = "./node_modules/@jsquash/jpeg/codec/";
await useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(codec + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(codec + "dec/mozjpeg_dec.wasm")),
});

/** Stored left half red, right half blue: shown with EXIF 6, red is on top. */
function redBlue(width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(x < width / 2 ? [220, 20, 20, 255] : [20, 20, 220, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

/** Adds an EXIF orientation tag right after SOI, as phones write it. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

const dataUrl = (jpeg: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;

async function blank() {
  const base = await PDFDocument.create();
  base.addPage([600, 800]);
  return base.save();
}

function pageOps(bytes: PDFDocument) {
  const page = bytes.getPage(0);
  const contents = page.node.Contents()!;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r) as PDFRawStream) : [contents as PDFRawStream];
  return streams.map((st) => Buffer.from(st.dict.get(PDFName.of("Filter")) ? inflateSync(st.contents) : st.contents).toString("latin1")).join("\n");
}

function storedImages(doc: PDFDocument) {
  return doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
    .map((o) => ({ width: (o.dict.get(PDFName.of("Width")) as PDFNumber).asNumber(), height: (o.dict.get(PDFName.of("Height")) as PDFNumber).asNumber() }));
}

// A 400 x 200 photo shown as 200 x 400, in a 200 x 400 pt box at (100, 100).
const small = withOrientation(await encodeJpeg(redBlue(400, 200), { quality: 95 }), 6);
check("test photo carries EXIF 6", jpegOrientation(small) === 6);
const photo: Annotation = { id: "p", page: 0, type: "image", x: 100, y: 100, width: 200, height: 400, dataUrl: dataUrl(small), signature: false };
const out = await bakeAnnotations(await blank(), [photo]);
const doc = await PDFDocument.load(out);
// Orientation 6 maps the stored picture's unit square turned a quarter: [0 -h w 0 x y+h].
// In PDF space (bottom-left origin, 800 high) the box runs from y 300 to 700.
check("edit: an EXIF 6 photo is drawn turned upright, filling its box", pageOps(doc).includes("0 -400 200 0 100 700 cm"), pageOps(doc).match(/[-\d. ]+ cm\n(?:1 0 0 1 0 0 cm\n)?[-\d. ]+ cm\n/g));
check("edit: the picture is stored as it came (sideways)", JSON.stringify(storedImages(doc)) === JSON.stringify([{ width: 400, height: 200 }]), storedImages(doc));

// A 6000 x 3000 phone photo in the same box: 300 DPI of 200 x 400 pt is 833 x 1667 shown, so 1667 x 833 stored.
const big = withOrientation(await encodeJpeg(redBlue(6000, 3000), { quality: 90 }), 6);
const bigOut = await PDFDocument.load(await bakeAnnotations(await blank(), [{ ...photo, dataUrl: dataUrl(big) }]));
check("edit: a big sideways photo is right-sized for the box it fills", JSON.stringify(storedImages(bigOut)) === JSON.stringify([{ width: 1667, height: 833 }]), storedImages(bigOut));

// As pdf.js shows it: red on top, blue below, nothing left blank in the box.
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
} catch {
  console.log("SKIP  pdf.js render checks (node-canvas not installed)");
}
if (canvasMod) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const d = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
  const pg = await d.getPage(1);
  const vp = pg.getViewport({ scale: 1 });
  const c = canvasMod.createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const at = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
  const isRed = ([r, , b]: number[]) => r > 150 && b < 100;
  const isBlue = ([r, , b]: number[]) => b > 150 && r < 100;
  // The box spans x 100-300, y 100-500 as the reader sees the page.
  const spots = { top: at(200, 150), bottom: at(200, 450), topLeft: at(105, 105), bottomRight: at(295, 495) };
  check("edit: pdf.js shows the photo upright (red on top, blue below), filling the box", isRed(spots.top) && isRed(spots.topLeft) && isBlue(spots.bottom) && isBlue(spots.bottomRight), spots);
  await d.destroy();
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
