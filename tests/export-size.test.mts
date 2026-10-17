process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// Export sizing: JPEG quality mapping, DPI maths, the downscaler, lossless
// PDF images, Images -> PDF right-sizing, one copy of repeated pictures, and
// which zip entries are deflated.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync, crc32, inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import type { RawImage } from "../lib/image-codec.ts";
import { downsampleTarget, resizeRgba, screenRatio } from "../lib/image-fit.ts";
import {
  decodePng,
  embedFlate,
  encodeFlate,
  flateToPng,
  flatness,
  pngAsIs,
  readPng,
} from "../lib/pdf/flate-image.ts";
import { looksPhotographic, smallerRender } from "../lib/pdf/embed-image.ts";
import { jpegChannels, jpegOrientation } from "../lib/pdf/images.ts";
import { imagesToPdfTool } from "../lib/pdf/toolkit.ts";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { tablesToXlsx } from "../lib/pdf/convert.ts";
import { writePptx } from "../lib/pptx/write.ts";
import { zipEntryOptions, zipEntryOptionsFor } from "../lib/zip.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Loaded dynamically: tsx gives a static import its own copy of the module,
// and the wasm has to reach the copy the app modules use.
const { decodeJpeg, encodeJpeg, isGray, mozQuality, useJpegWasm } = await import("../lib/image-codec.ts");
const codec = "./node_modules/@jsquash/jpeg/codec/";
await useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(codec + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(codec + "dec/mozjpeg_dec.wasm")),
});

function image(width: number, height: number, px: (x: number, y: number) => [number, number, number, number?]): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = px(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}
let seed = 1;
const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255;
/** Photo-like: smooth gradients plus grain. */
const photo = (w: number, h: number) =>
  image(w, h, (x, y) => [((x / w) * 200 + noise() * 0.2) | 0, ((y / h) * 200 + noise() * 0.2) | 0, (120 + noise() * 0.3) | 0]);

/** Adds an EXIF orientation tag right after SOI, as phones write it. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

/** Image XObjects in a PDF (soft masks not counted), with their pixel size, filter and colour space. */
async function pdfImages(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const found: { width: number; height: number; filter: string; length: number; colorSpace: string; contents: Uint8Array }[] = [];
  const masks = new Set<unknown>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const sm = obj.dict.get(PDFName.of("SMask"));
      if (sm) masks.add(sm.toString());
    }
  }
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (masks.has(ref.toString())) continue;
    const n = (k: string) => (obj.dict.get(PDFName.of(k)) as PDFNumber).asNumber();
    found.push({
      width: n("Width"),
      height: n("Height"),
      filter: String(obj.dict.get(PDFName.of("Filter"))),
      length: obj.contents.length,
      colorSpace: String(obj.dict.get(PDFName.of("ColorSpace"))),
      contents: obj.contents,
    });
  }
  return found;
}

// --- JPEG quality mapping -----------------------------------------------------
check("mozQuality: browser 0.92 looks like MozJPEG 95", mozQuality(0.92) === 95, mozQuality(0.92));
check("mozQuality: browser 0.85 looks like MozJPEG 90", mozQuality(0.85) === 90, mozQuality(0.85));
check("mozQuality: stays within 1-100", mozQuality(1) === 100 && mozQuality(0) >= 1 && mozQuality(-1) >= 1);

/** Sampling factors (H×V) of each channel, from a JPEG's frame header. */
function sampling(jpeg: Uint8Array): string[] {
  for (let i = 2; i + 4 < jpeg.length; ) {
    const marker = jpeg[i + 1];
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker === 0xc0 || marker === 0xc2) {
      const out: string[] = [];
      for (let c = 0; c < jpeg[i + 9]; c++) {
        const f = jpeg[i + 11 + c * 3];
        out.push(`${f >> 4}x${f & 15}`);
      }
      return out;
    }
    i += 2 + len;
  }
  return [];
}
const colourful = image(64, 64, (x, y) => [x * 4, y * 4, 255 - x * 4]);
check("encodeJpeg: colour halved both ways by default (4:2:0)", sampling(await encodeJpeg(colourful, { quality: 90 })).join() === "2x2,1x1,1x1");
check("encodeJpeg: fullChroma keeps colour at full resolution (4:4:4)", sampling(await encodeJpeg(colourful, { quality: 100, fullChroma: true })).join() === "1x1,1x1,1x1");
const greyJpeg = await encodeJpeg(image(64, 64, (x) => [x * 4, x * 4, x * 4]), { quality: 90, gray: true });
check("encodeJpeg: gray writes one channel", jpegChannels(greyJpeg) === 1 && sampling(greyJpeg).length === 1);
check("isGray: grey yes, colour no", isGray(image(8, 8, (x) => [x, x, x])) && !isGray(colourful));

// --- Sizing maths -------------------------------------------------------------
check("screenRatio: 16:9 slide (960x540 pt) renders 1920x1080", screenRatio(960, 540) * 960 === 1920 && screenRatio(960, 540) * 540 === 1080);
check("screenRatio: 4:3 slide renders 1440x1080", Math.round(screenRatio(720, 540) * 720) === 1440 && Math.round(screenRatio(720, 540) * 540) === 1080);
check("screenRatio: 10-inch 16:9 slide also gets 1920 px", Math.round(screenRatio(720, 405) * 720) === 1920);
const a4 = screenRatio(595.28, 841.89);
check("screenRatio: a portrait slide fits a portrait 1080p screen", Math.round(a4 * 595.28) === 1080 && a4 * 841.89 <= 1920, [a4 * 595.28, a4 * 841.89]);
// A 12 MP phone photo across an A4 page (595 pt wide): ~488 DPI -> 300 DPI.
const t = downsampleTarget(4032, 3024, 595.28, 446.46);
check("downsampleTarget: phone photo on A4 drops to 300 DPI", !!t && t.width === 2480 && t.height === 1860, t);
check("downsampleTarget: an image at 300 DPI or less is left alone", downsampleTarget(2480, 1860, 595.28, 446.46) === null && downsampleTarget(1000, 800, 595, 476) === null);
check("downsampleTarget: a few percent over isn't worth a re-encode", downsampleTarget(2600, 1950, 595.28, 446.46) === null);
const stretched = downsampleTarget(3000, 3000, 720, 144);
check("downsampleTarget: a stretched placement keeps 300 DPI on both axes", stretched === null, stretched);

// --- Downscaler ---------------------------------------------------------------
const checker = image(4, 4, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
const half = resizeRgba(checker, 2, 2);
check("resizeRgba: 2x box average of a checkerboard is mid grey", Array.from(half.data).every((v, i) => (i % 4 === 3 ? v === 255 : Math.abs(v - 128) <= 1)), Array.from(half.data));
const odd = resizeRgba(image(7, 5, () => [200, 100, 50]), 3, 2);
check("resizeRgba: non-integer factors keep a flat colour exact", odd.width === 3 && odd.height === 2 && Array.from(odd.data).every((v, i) => v === [200, 100, 50, 255][i % 4]));
const edge = resizeRgba(image(2, 1, (x) => (x ? [0, 0, 255, 255] : [255, 0, 0, 0])), 1, 1);
check("resizeRgba: transparent pixels don't bleed colour", edge.data[0] === 0 && edge.data[2] === 255 && Math.abs(edge.data[3] - 128) <= 1, Array.from(edge.data));
check("resizeRgba: never upscales", resizeRgba(checker, 8, 8).width === 4);

// --- Lossless images ----------------------------------------------------------
const flat = image(300, 200, (x, y) => (x < 150 ? [20, 40, 200] : y < 100 ? [255, 255, 255] : [240, 120, 0]));
const pal = await encodeFlate(flat);
check("encodeFlate: 3 colours become a 2-bit palette", !!pal.palette && pal.bitsPerComponent === 2 && pal.palette.length === 9);
const grey = await encodeFlate(image(64, 64, (x, y) => [x * 4, x * 4, x * 4]));
check("encodeFlate: greyscale stays one channel", !grey.palette && grey.colors === 1 && grey.bitsPerComponent === 8);
const rgbImg = photo(64, 64);
const rgbEnc = await encodeFlate(rgbImg);
check("encodeFlate: many colours become RGB", !rgbEnc.palette && rgbEnc.colors === 3);
for (const [name, img, enc] of [["palette", flat, pal], ["RGB", rgbImg, rgbEnc]] as const) {
  const back = await decodePng(readPng(flateToPng(enc))!);
  check(`flateToPng -> decodePng round trip is exact (${name})`, !!back && back.data.every((v, i) => v === img.data[i]));
}
check("flatness: flat graphics near 1, photos low", flatness(flat) > 0.95 && flatness(photo(200, 100)) < 0.2);
check("looksPhotographic: photo yes, flat graphic no", looksPhotographic(photo(200, 100)) && !looksPhotographic(flat));

// Rendered slides: lossless only when no bigger than the JPEG.
/** A 1080p white slide: a title bar, lines of word-like blocks, and an optional photo inset. */
function slide(inset: number) {
  const pic = photo(inset, Math.round(inset * 0.75));
  return image(1920, 1080, (x, y) => {
    if (inset && x >= 1500 && x < 1500 + pic.width && y >= 100 && y < 100 + pic.height) {
      const i = ((y - 100) * pic.width + (x - 1500)) * 4;
      return [pic.data[i], pic.data[i + 1], pic.data[i + 2]];
    }
    if (y >= 80 && y < 160 && x >= 120 && x < 1100) return [30, 60, 140];
    const line = Math.floor((y - 260) / 60);
    const inLine = y >= 260 && line < 8 && (y - 260) % 60 < 22;
    const word = Math.floor((x - 120) / 110);
    const ink = inLine && x >= 120 && x < 1300 - line * 60 && (x - 120) % 110 < 70 + ((word * 13 + line * 7) % 30);
    return ink ? [25, 25, 35] : [255, 255, 255];
  });
}
// The photo is small enough that the slide is still 98% flat.
for (const [name, inset, want] of [["a text slide", 0, "flate"], ["a text slide with a 200 px photo", 200, "jpeg"]] as const) {
  const px = slide(inset);
  const jpeg = await encodeJpeg(px, { quality: mozQuality(0.92) });
  const got = await smallerRender(px, jpeg);
  const lossless = "flate" in got ? got.flate.data.length : (await encodeFlate(px)).data.length;
  check(`smallerRender: ${name} keeps the smaller (${want})`, want in got, { jpeg: jpeg.length, lossless });
}

/** A real PNG built with zlib, like other tools write it. */
function makePng(img: RawImage, colorType: 2 | 6): Uint8Array {
  const ch = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc((img.width * ch + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      for (let c = 0; c < ch; c++) raw[y * (img.width * ch + 1) + 1 + x * ch + c] = img.data[(y * img.width + x) * 4 + c];
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
  );
}
const screenshot = image(400, 300, (x, y) => (y < 40 ? [30, 30, 60] : x % 50 < 2 ? [200, 200, 200] : [255, 255, 255]));
const shotPng = makePng(screenshot, 2);
check("pngAsIs: an opaque 8-bit PNG goes in as stored", pngAsIs(readPng(shotPng)!)?.data.length === readPng(shotPng)!.idat.length);
const alphaPng = makePng(image(50, 50, (x, y) => [x * 5, y * 5, 100, x < 25 ? 255 : 80]), 6);
check("pngAsIs: a PNG with alpha needs splitting", pngAsIs(readPng(alphaPng)!) === null);

// Rendered by pdf.js, lossless images match their source pixel for pixel.
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
} catch {
  console.log("SKIP  pdf.js render checks (node-canvas not installed)");
}
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
async function renderPage(pdf: Uint8Array, pageNo = 1, scale = 1) {
  const d = await pdfjs.getDocument({ data: pdf.slice(), verbosity: 0 }).promise;
  const pg = await d.getPage(pageNo);
  const vp = pg.getViewport({ scale });
  const c = canvasMod!.createCanvas(Math.round(vp.width), Math.round(vp.height));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  await d.destroy();
  return { px, width: c.width, height: c.height };
}
if (canvasMod) {
  for (const [name, img] of [["palette", flat], ["RGB", rgbImg], ["alpha", (await decodePng(readPng(alphaPng)!))!]] as const) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([img.width, img.height]);
    const { drawOrientedImage } = await import("../lib/pdf/images.ts");
    drawOrientedImage(page, { ref: embedFlate(doc, await encodeFlate(img)) }, 1, { x: 0, y: 0, width: img.width, height: img.height });
    const r = await renderPage(await doc.save());
    let worst = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      const a = img.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(img.data[i + c] * a + 255 * (1 - a) - r.px[i + c]));
    }
    check(`embedFlate: pdf.js shows the ${name} image exactly`, worst <= 1, worst);
  }
}

// --- Images -> PDF -----------------------------------------------------------
const file = (bytes: Uint8Array, name: string, type: string) => new File([bytes.slice() as unknown as BlobPart], name, { type });
// A 6000x3000 photo, red on the left, stored sideways with EXIF 6 (shows portrait: red on top).
const wide = image(6000, 3000, (x) => {
  const n = noise() * 0.25;
  return x < 3000 ? [(190 + n) | 0, (30 + n) | 0, (30 + n) | 0] : [(30 + n) | 0, (30 + n) | 0, (190 + n) | 0];
});
const sideways = withOrientation(await encodeJpeg(wide, { quality: 92 }), 6);
check("test photo carries EXIF 6", jpegOrientation(sideways) === 6);
const onA4 = new Uint8Array(await (await imagesToPdfTool([file(sideways, "phone.jpg", "image/jpeg")], { pageSize: "a4", margin: "0" })).blob.arrayBuffer());
const [shrunk] = await pdfImages(onA4);
// Shown 420.9 x 841.9 pt on A4 portrait: 300 DPI is 1754 x 3508 px, stored sideways.
check("jpg-to-pdf (A4): a photo above 300 DPI is stored at 300 DPI", shrunk.width === 3508 && shrunk.height === 1754 && shrunk.filter === "/DCTDecode", shrunk);
check("jpg-to-pdf (A4): and is smaller than the original", onA4.length < sideways.length * 0.85, { pdf: onA4.length, jpeg: sideways.length });
if (canvasMod) {
  const r = await renderPage(onA4, 1, 0.25);
  const at = (fx: number, fy: number) => {
    const i = (Math.floor(fy * r.height) * r.width + Math.floor(fx * r.width)) * 4;
    return [r.px[i], r.px[i + 1], r.px[i + 2]];
  };
  const top = at(0.5, 0.2);
  const bottom = at(0.5, 0.8);
  check("jpg-to-pdf (A4): EXIF orientation still applied (red on top)", top[0] > 150 && top[2] < 100 && bottom[2] > 150 && bottom[0] < 100, { top, bottom });
}
const progress: string[] = [];
const fit = new Uint8Array(
  await (
    await imagesToPdfTool([file(sideways, "phone.jpg", "image/jpeg"), file(sideways, "phone2.jpg", "image/jpeg")], { pageSize: "fit", margin: "0" }, {
      progress: (_f, label) => progress.push(label),
    })
  ).blob.arrayBuffer()
);
const fitDoc = await PDFDocument.load(fit);
const [fitted] = await pdfImages(fit);
// The default page size: 1 pt per pixel, but the picture is sized for A4 paper (long side 3508 px).
check("jpg-to-pdf (fit): a big photo is sized for A4 paper at 300 DPI", fitted.width === 3508 && fitted.height === 1754 && fitted.length < sideways.length * 0.85, { ...fitted, contents: undefined });
check("jpg-to-pdf (fit): the page stays 1 pt per pixel, portrait for EXIF 6", fitDoc.getPage(0).getWidth() === 3000 && fitDoc.getPage(0).getHeight() === 6000);
check("jpg-to-pdf: progress counts the images", progress.join() === "Image 1 of 2,Image 2 of 2", progress);
const modest = await encodeJpeg(photo(2000, 1500), { quality: 90 });
const [untouched] = await pdfImages(new Uint8Array(await (await imagesToPdfTool([file(modest, "m.jpg", "image/jpeg")], { pageSize: "fit", margin: "0" })).blob.arrayBuffer()));
check("jpg-to-pdf (fit): a photo that fits A4 at 300 DPI is kept as it is", untouched.width === 2000 && untouched.length === modest.length, { ...untouched, contents: undefined });

// A greyscale scan stays one channel when it is scaled down.
const greyScan = await encodeJpeg(image(4000, 2400, (x, y) => { const v = (x * 7 + y * 3 + noise() * 0.3) & 255; return [v, v, v]; }), { quality: 90, gray: true });
const [greyOut] = await pdfImages(new Uint8Array(await (await imagesToPdfTool([file(greyScan, "scan.jpg", "image/jpeg")], { pageSize: "a4", margin: "0" })).blob.arrayBuffer()));
check("jpg-to-pdf: a grey JPEG is scaled down as grey", greyOut.width === 2480 && greyOut.colorSpace === "/DeviceGray" && jpegChannels(greyOut.contents) === 1, { ...greyOut, contents: undefined });

// CMYK can't be decoded here: it goes in as it is, without trying (which logs an error).
const cmyk = sideways.slice();
for (let i = 2; i + 10 < cmyk.length; ) {
  if (cmyk[i + 1] === 0xc0) {
    cmyk[i + 9] = 4; // claims four channels
    break;
  }
  i += 2 + ((cmyk[i + 2] << 8) | cmyk[i + 3]);
}
const logged: unknown[] = [];
const consoleError = console.error;
console.error = (...args: unknown[]) => logged.push(args);
const [cmykOut] = await pdfImages(new Uint8Array(await (await imagesToPdfTool([file(cmyk, "cmyk.jpg", "image/jpeg")], { pageSize: "a4", margin: "0" })).blob.arrayBuffer()));
console.error = consoleError;
check("jpg-to-pdf: a CMYK JPEG goes in as it is, without a decode attempt", cmykOut.length === cmyk.length && cmykOut.colorSpace === "/DeviceCMYK" && !logged.length, { length: cmykOut.length, cs: cmykOut.colorSpace, logged });

const photoPng = makePng(photo(800, 600), 2);
const fromPhotoPng = new Uint8Array(await (await imagesToPdfTool([file(photoPng, "photo.png", "image/png")], { pageSize: "fit", margin: "0" })).blob.arrayBuffer());
const [asJpeg] = await pdfImages(fromPhotoPng);
check("jpg-to-pdf: a photographic PNG becomes a much smaller JPEG", asJpeg.filter === "/DCTDecode" && fromPhotoPng.length < photoPng.length * 0.5, { filter: asJpeg.filter, pdf: fromPhotoPng.length, png: photoPng.length });
const fromShot = new Uint8Array(await (await imagesToPdfTool([file(shotPng, "shot.png", "image/png")], { pageSize: "fit", margin: "0" })).blob.arrayBuffer());
const [shotImg] = await pdfImages(fromShot);
check("jpg-to-pdf: a screenshot stays lossless", shotImg.filter === "/FlateDecode", shotImg);
check("jpg-to-pdf: and is no bigger than the PNG it came from", shotImg.length <= readPng(shotPng)!.idat.length, { pdf: shotImg.length, png: readPng(shotPng)!.idat.length });
if (canvasMod) {
  const r = await renderPage(fromShot);
  check("jpg-to-pdf: screenshot pixels are exact", r.width === 400 && screenshot.data.every((v, i) => i % 4 === 3 || v === r.px[i]));
}

// --- Edit PDF: one copy of a picture placed many times ------------------------
{
  const base = await PDFDocument.create();
  for (let i = 0; i < 3; i++) base.addPage([612, 792]);
  const big = await encodeJpeg(photo(3000, 2000), { quality: 90 });
  const dataUrl = `data:image/jpeg;base64,${Buffer.from(big).toString("base64")}`;
  // Square boxes: the 3:2 photo shows 200 x 133 pt, centred, as the editor shows it.
  const anns: Annotation[] = [0, 1, 2].map((page) => ({ id: `i${page}`, page, type: "image", x: 50, y: 50, width: 200, height: 200, dataUrl, signature: false }));
  const out = await bakeAnnotations(await base.save(), anns);
  const imgs = await pdfImages(out);
  check("edit: a picture on three pages is stored once", imgs.length === 1, imgs.length);
  // 200 pt wide at 300 DPI = 833 px.
  check("edit: a big photo shown 200 pt wide is stored at 300 DPI", imgs[0]?.width === 833, { ...imgs[0], contents: undefined });
  const page1 = (await PDFDocument.load(out)).getPage(0);
  const contents = page1.node.Contents()!;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page1.doc.context.lookup(r) as PDFRawStream) : [contents as PDFRawStream];
  const ops = streams
    .map((st) => Buffer.from(st.dict.get(PDFName.of("Filter")) ? inflateSync(st.contents) : st.contents).toString("latin1"))
    .join("\n");
  const placed = /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n([\d.]+) 0 0 ([\d.]+) 0 0 cm\n1 0 0 1 0 0 cm\n\/Image/.exec(ops)?.slice(1).map((v) => Math.round(Number(v)));
  // Box (50, 50) 200 x 200 on a 792 pt page: bottom 542, image 133 high, 33 pt from the box bottom.
  check("edit: the photo keeps its proportions, centred in its box", JSON.stringify(placed) === JSON.stringify([50, 575, 200, 133]), placed);
  check("edit: the export is smaller than the photo alone", out.length < big.length, { out: out.length, photo: big.length });
  const stored = (await PDFDocument.load(out)).context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .find((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))!;
  const back = await decodeJpeg(stored.contents);
  check("edit: the stored picture decodes", back.width === 833 && back.height === 556, [back.width, back.height]);
}

// --- Zips --------------------------------------------------------------------
check("zip: XML deflated hard", zipEntryOptions("ppt/slides/slide1.xml").compression === "DEFLATE" && zipEntryOptions("a.xml").compressionOptions?.level === 9);
check("zip: text-like files deflated hard", ["a.csv", "b.txt", "c.md", "d.json", "_rels/.rels"].every((n) => zipEntryOptions(n).compressionOptions?.level === 9));
check("zip: compressed media and Office files stored", ["a.jpg", "b.JPEG", "c.png", "d.mp3", "e.mp4", "f.zip", "g.docx", "h.xlsx", "i.pptx"].every((n) => zipEntryOptions(n).compression === "STORE"));
check("zip: PDFs deflated at the usual level", zipEntryOptions("page-1.pdf").compression === "DEFLATE" && zipEntryOptions("page-1.pdf").compressionOptions?.level === 6);
{
  // A PDF of scans barely deflates: stored. One of text deflates well: deflated.
  const scanned = new Uint8Array(randomBytes(1_000_000));
  const texty = new TextEncoder().encode("BT /F1 12 Tf 72 700 Td (Quarterly revenue grew in every region) Tj ET\n".repeat(15000));
  const asScan = await zipEntryOptionsFor("scan.pdf", new Blob([scanned]));
  const asText = await zipEntryOptionsFor("report.pdf", new Blob([texty]));
  const small = await zipEntryOptionsFor("small.pdf", new Blob([scanned.subarray(0, 100_000)]));
  check("zip: a PDF that doesn't deflate is stored", asScan.compression === "STORE", asScan);
  check("zip: a PDF that deflates is deflated", asText.compression === "DEFLATE" && asText.compressionOptions?.level === 6, asText);
  check("zip: small files are deflated without sampling", small.compression === "DEFLATE", small);
  check("zip: images stay stored", (await zipEntryOptionsFor("a.jpg", new Blob([texty]))).compression === "STORE");
}

/** Compression method of each entry, from the zip's central directory. */
function methods(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Record<string, string> = {};
  for (let i = 0; i + 46 <= bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const method = view.getUint16(i + 10, true);
    const nameLen = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLen));
    out[name] = method === 8 ? "deflate" : method === 0 ? "store" : String(method);
    i += 45 + nameLen;
  }
  return out;
}
const tinyJpeg = await encodeJpeg(photo(64, 48), { quality: 80 });
const pptx = await writePptx({ width: 9144000, height: 5143500, slides: [{ image: tinyJpeg, format: "jpeg" }], date: new Date(0) });
const pm = methods(pptx);
check("pptx: slide picture stored, parts deflated", pm["ppt/media/image1.jpeg"] === "store" && pm["ppt/slides/slide1.xml"] === "deflate" && pm["[Content_Types].xml"] === "deflate", pm);
const xlsx = await tablesToXlsx([{ type: "table", page: 1, rows: [["A", "B"], ["1", "2"]] } as unknown as Parameters<typeof tablesToXlsx>[0][number]]);
const xm = methods(xlsx);
check("xlsx: every part deflated", Object.values(xm).every((m) => m === "deflate"), xm);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
