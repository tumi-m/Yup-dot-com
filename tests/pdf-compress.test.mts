process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { zlibSync } from "fflate";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  StandardFonts,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";

// Import without extensions so these share one module instance with the code under test.
const codec = await import("../lib/image-codec");
const { compressPdf, presetFrom, PRESETS } = await import("../lib/pdf/compress/index");
const { scanContent } = await import("../lib/pdf/compress/lexer");
const { decodeFully, predictPng, unpredict } = await import("../lib/pdf/compress/streams");
const { resize } = await import("../lib/pdf/compress/resample");
const { compressTool } = await import("../lib/pdf/toolkit");

const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// ---------------------------------------------------------------------------
// Synthetic pictures
// ---------------------------------------------------------------------------

function random(seed: number) {
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
}

/** Photo-like RGB pixels: fractal value noise over colour gradients, plus grain. */
function photo(w: number, h: number, seed = 1): Uint8Array {
  const rand = random(seed);
  const acc = new Float32Array(w * h * 3);
  let amp = 0.55;
  for (let cell = Math.max(w, h) / 3; cell >= 1.5; cell /= 2, amp *= 0.62) {
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const grid = new Float32Array(gw * gh * 3).map(() => rand() - 0.5);
    for (let y = 0; y < h; y++) {
      const gy = y / cell;
      const y0 = Math.floor(gy);
      const ty = gy - y0;
      for (let x = 0; x < w; x++) {
        const gx = x / cell;
        const x0 = Math.floor(gx);
        const tx = gx - x0;
        const i00 = (y0 * gw + x0) * 3;
        const i10 = i00 + 3;
        const i01 = i00 + gw * 3;
        const i11 = i01 + 3;
        const o = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) {
          const top = grid[i00 + c] * (1 - tx) + grid[i10 + c] * tx;
          const bottom = grid[i01 + c] * (1 - tx) + grid[i11 + c] * tx;
          acc[o + c] += amp * (top * (1 - ty) + bottom * ty);
        }
      }
    }
  }
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const base = [0.35 + 0.4 * (x / w), 0.3 + 0.4 * (y / h), 0.6 - 0.3 * (x / w)];
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, 255 * (base[c] + acc[o + c]) + (rand() - 0.5) * 12));
    }
  }
  return out;
}

/** A bar chart: a few flat colours with hard edges. */
function chart(w: number, h: number): Uint8Array {
  const colors = [
    [255, 255, 255],
    [109, 40, 217],
    [16, 185, 129],
    [245, 158, 11],
    [30, 30, 30],
  ];
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = colors[0];
      const bar = Math.floor(x / (w / 8));
      const top = h * (0.2 + 0.08 * ((bar * 5) % 7));
      if (x % (w / 8) > w / 40 && y > top) c = colors[1 + (bar % 3)];
      if (y > h - 4 || x < 3) c = colors[4];
      out.set(c, (y * w + x) * 3);
    }
  }
  return out;
}

const rgba = (rgb: Uint8Array) => {
  const out = new Uint8ClampedArray((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
};

const jpeg = (rgb: Uint8Array, w: number, h: number, quality = 90) =>
  codec.encodeJpeg({ data: rgba(rgb), width: w, height: h }, { quality });

// ---------------------------------------------------------------------------
// PDF building blocks
// ---------------------------------------------------------------------------

function imageXObject(context: PDFContext, w: number, h: number, data: Uint8Array, entries: Record<string, unknown>): PDFRef {
  const dict: Record<string, unknown> = { Type: "XObject", Subtype: "Image", Width: w, Height: h, BitsPerComponent: 8, ...entries };
  return context.register(context.stream(data, dict as never));
}

const flateImage = (context: PDFContext, w: number, h: number, pixels: Uint8Array, colorSpace: string, extra = {}) =>
  imageXObject(context, w, h, zlibSync(pixels, { level: 6 }), { ColorSpace: colorSpace, Filter: "FlateDecode", ...extra });

const jpegImage = (context: PDFContext, w: number, h: number, bytes: Uint8Array, colorSpace = "DeviceRGB") =>
  imageXObject(context, w, h, bytes, { ColorSpace: colorSpace, Filter: "DCTDecode" });

function addPage(doc: PDFDocument, size: [number, number], content: string, xobjects: Record<string, PDFRef>) {
  const page = doc.addPage(size);
  for (const [name, ref] of Object.entries(xobjects)) page.node.setXObject(PDFName.of(name), ref);
  page.node.addContentStream(doc.context.register(doc.context.stream(content)));
  return page;
}

/** Image XObjects drawn on each page of a saved PDF (following forms). */
async function imagesOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const found: { ref: PDFRef; stream: PDFRawStream; page: number }[] = [];
  const visit = (res: PDFObject | undefined, page: number) => {
    const xobjects = res instanceof PDFDict ? res.lookup(PDFName.of("XObject")) : undefined;
    if (!(xobjects instanceof PDFDict)) return;
    for (const [, ref] of xobjects.entries()) {
      const s = doc.context.lookup(ref);
      if (!(s instanceof PDFRawStream) || !(ref instanceof PDFRef)) continue;
      if (s.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) found.push({ ref, stream: s, page });
      else visit(s.dict.lookup(PDFName.of("Resources")), page);
    }
  };
  doc.getPages().forEach((p, i) => visit(p.node.Resources(), i));
  return { doc, found };
}

const dims = (s: PDFRawStream) => [
  (s.dict.lookup(PDFName.of("Width")) as PDFNumber).asNumber(),
  (s.dict.lookup(PDFName.of("Height")) as PDFNumber).asNumber(),
];
const filterOf = (s: PDFRawStream) => s.dict.lookup(PDFName.of("Filter"))?.toString();
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** Decoded 8-bit samples of a Flate image (palette and few-bit images expanded). */
function samples(context: PDFContext, s: PDFRawStream): { data: Uint8Array; ch: number } {
  const [w, h] = dims(s);
  const bits = (s.dict.lookup(PDFName.of("BitsPerComponent")) as PDFNumber).asNumber();
  const cs = s.dict.lookup(PDFName.of("ColorSpace"));
  const raw = decodeFully(context, s)!;
  const indexed = cs instanceof PDFArray && cs.lookup(0) === PDFName.of("Indexed");
  const base = indexed ? cs.lookup(1) : cs;
  const ch = base === PDFName.of("DeviceRGB") ? 3 : base === PDFName.of("DeviceCMYK") ? 4 : 1;
  const comps = indexed ? 1 : ch;
  const rowBytes = Math.ceil((w * comps * bits) / 8);
  const out = new Uint8Array(w * h * ch);
  let palette: Uint8Array | null = null;
  if (indexed) {
    const hex = cs.lookup(3).toString().replace(/[<>]/g, "");
    palette = new Uint8Array(hex.length / 2).map((_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w * comps; x++) {
      const bit = x * bits;
      const byte = raw[y * rowBytes + (bit >> 3)];
      const v = bits === 8 ? byte : (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
      if (palette) out.set(palette.subarray(v * ch, v * ch + ch), (y * w + x) * ch);
      else out[y * w * ch + x] = bits === 8 ? v : Math.round((v * 255) / ((1 << bits) - 1));
    }
  }
  return { data: out, ch };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function jpegComponents(b: Uint8Array): number {
  for (let i = 2; i + 9 < b.length; ) {
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return b[i + 9];
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return 0;
}

async function pdfjsDoc(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjsDoc(bytes);
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    text += (tc.items as { str: string }[]).map((t) => t.str).join(" ") + "\n";
  }
  await doc.destroy();
  return text;
}

const file = (bytes: Uint8Array, name: string) => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });

// Shared pictures.
const BIG_W = 2400;
const BIG_H = 1600;
const bigPhoto = photo(BIG_W, BIG_H, 7);
const bigJpeg = await jpeg(bigPhoto, BIG_W, BIG_H, 92);
/** Pixels needed to show `pt` points at a preset's resolution. */
const px = (pt: number, preset: "smallest" | "balanced" | "high" = "balanced", factor = 1) => Math.round((pt / 72) * PRESETS[preset].dpi * factor);
// Every big photo below is shown at 300 × 200 pt.
const TARGET = [px(300), px(200)];

// ---------------------------------------------------------------------------
// 1. A big photo placed small; its text stays text
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const im = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  const page = addPage(doc, [595, 842], "q 300 0 0 200 150 400 cm /Im0 Do Q", { Im0: im });
  page.drawText("Quarterly report: revenue up 12%", { x: 50, y: 780, size: 14, font });
  const input = await doc.save();
  const labels: string[] = [];
  const out = await compressPdf(input, { preset: "balanced", onProgress: (_f, label) => labels.push(label) });
  const { found } = await imagesOf(out);
  const [w, h] = dims(found[0].stream);
  check("photo: downsampled to what the placement needs", near(w, TARGET[0]) && near(h, TARGET[1]), [w, h, TARGET]);
  check("photo: still a JPEG", filterOf(found[0].stream) === "/DCTDecode");
  check("photo: file much smaller", out.length < input.length * 0.2, [input.length, out.length]);
  check("photo: progress names the image", labels.includes("Image 1 of 1"), labels);
  check("text: still extractable after compression", (await pageText(out)).includes("Quarterly report: revenue up 12%"));

  const small = await compressPdf(input, { preset: "smallest" });
  const high = await compressPdf(input, { preset: "high" });
  const sw = dims((await imagesOf(small)).found[0].stream)[0];
  const hw = dims((await imagesOf(high)).found[0].stream)[0];
  check("presets: smallest < balanced < high", small.length < out.length && out.length < high.length, [small.length, out.length, high.length]);
  check("presets: each at its own resolution", near(sw, px(300, "smallest")) && near(hw, px(300, "high")), [sw, hw]);

  // A second pass finds almost nothing left to gain.
  const again = await compressPdf(out, { preset: "balanced" });
  check("second pass: under 2% further gain", again.length > out.length * 0.98, [out.length, again.length]);
}

// ---------------------------------------------------------------------------
// 2. Flate photo → JPEG; flat graphics stay lossless
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const pw = 1200;
  const ph = 800;
  const flatePhoto = flateImage(doc.context, pw, ph, photo(pw, ph, 3), "DeviceRGB");
  const chartPx = chart(800, 600);
  const flat = flateImage(doc.context, 800, 600, chartPx, "DeviceRGB");
  const bigChart = flateImage(doc.context, 3000, 2000, chart(3000, 2000), "DeviceRGB");
  addPage(doc, [595, 842], "q 288 0 0 192 50 600 cm /P Do Q q 400 0 0 300 50 250 cm /C Do Q q 150 0 0 100 50 50 cm /B Do Q", {
    P: flatePhoto,
    C: flat,
    B: bigChart,
  });
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const { doc: outDoc, found } = await imagesOf(out);
  const byWidth = (w: number) => found.find((f) => dims(f.stream)[0] === w);
  const p = found.find((f) => filterOf(f.stream) === "/DCTDecode");
  check("flate photo: becomes a downsampled JPEG", !!p && near(dims(p.stream)[0], px(288)), p && dims(p.stream));
  const c = byWidth(800);
  check("flat graphic: kept at full size and lossless (Flate)", !!c && filterOf(c.stream) === "/FlateDecode");
  check("flat graphic: pixels identical", !!c && sameBytes(samples(outDoc.context, c.stream).data, chartPx));
  const b = found.find((f) => dims(f.stream)[0] !== 800 && filterOf(f.stream) === "/FlateDecode");
  // 3000 px over 150 pt is 1440 PPI: brought down to 1.5 × the preset's resolution, still lossless.
  check("oversampled flat graphic: reduced but lossless", !!b && near(dims(b.stream)[0], px(150, "balanced", 1.5)), b && dims(b.stream));
}

// ---------------------------------------------------------------------------
// 3. Soft masks follow their image; CMYK and odd images are left alone
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const w = 1600;
  const h = 1200;
  const alpha = new Uint8Array(w * h).map((_, i) => Math.round((255 * (i % w)) / w));
  const mask = flateImage(doc.context, w, h, alpha, "DeviceGray");
  const withMask = flateImage(doc.context, w, h, photo(w, h, 5), "DeviceRGB", { SMask: mask });
  const cmykPixels = new Uint8Array(800 * 600 * 4).map((_, i) => (i * 37) % 251);
  const cmyk = flateImage(doc.context, 800, 600, cmykPixels, "DeviceCMYK");
  const cmykJpegRef = imageXObject(doc.context, 8, 8, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { ColorSpace: "DeviceCMYK", Filter: "DCTDecode" });
  const indexed = imageXObject(doc.context, 400, 300, zlibSync(new Uint8Array(400 * 300).map((_, i) => i % 4)), {
    ColorSpace: doc.context.obj([PDFName.of("Indexed"), PDFName.of("DeviceRGB"), 3, PDFString.of("abcdefghijkl")]),
    Filter: "FlateDecode",
  });
  addPage(doc, [595, 842], "q 200 0 0 150 50 600 cm /A Do Q q 100 0 0 75 50 400 cm /K Do Q q 50 0 0 50 50 300 cm /J Do Q q 40 0 0 30 50 200 cm /I Do Q", {
    A: withMask,
    K: cmyk,
    J: cmykJpegRef,
    I: indexed,
  });
  const input = await doc.save();
  const out = await compressPdf(input, { preset: "balanced" });
  const { doc: outDoc, found } = await imagesOf(out);
  const parent = found.find((f) => f.stream.dict.has(PDFName.of("SMask")))!;
  const smask = outDoc.context.lookup(parent.stream.dict.get(PDFName.of("SMask"))) as PDFRawStream;
  check("soft mask: parent downsampled", near(dims(parent.stream)[0], px(200)), dims(parent.stream));
  check("soft mask: resized with its image", JSON.stringify(dims(smask)) === JSON.stringify(dims(parent.stream)), [dims(smask), dims(parent.stream)]);
  check("soft mask: lossless and gray", filterOf(smask) === "/FlateDecode" && smask.dict.lookup(PDFName.of("ColorSpace")) === PDFName.of("DeviceGray"));
  const k = found.find((f) => f.stream.dict.lookup(PDFName.of("ColorSpace")) === PDFName.of("DeviceCMYK") && filterOf(f.stream) === "/FlateDecode")!;
  check("cmyk: size kept", JSON.stringify(dims(k.stream)) === "[800,600]");
  check("cmyk: pixels identical", sameBytes(samples(outDoc.context, k.stream).data, cmykPixels));
  const j = found.find((f) => filterOf(f.stream) === "/DCTDecode" && f.stream.dict.lookup(PDFName.of("ColorSpace")) === PDFName.of("DeviceCMYK"));
  check("cmyk jpeg: untouched", !!j && sameBytes(j.stream.contents, new Uint8Array([0xff, 0xd8, 0xff, 0xd9])));
  const ix = found.find((f) => f.stream.dict.lookup(PDFName.of("ColorSpace")) instanceof PDFArray);
  check("indexed: size kept", !!ix && JSON.stringify(dims(ix.stream)) === "[400,300]");
}

// ---------------------------------------------------------------------------
// 4. Duplicates, forms and rotation
// ---------------------------------------------------------------------------
{
  // The same picture stored twice (as merging two PDFs does), shown small and large.
  const doc = await PDFDocument.create();
  const a = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  const b = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  addPage(doc, [595, 842], "q 90 0 0 60 50 50 cm /Im0 Do Q", { Im0: a });
  addPage(doc, [595, 842], "q 300 0 0 200 50 50 cm /Im0 Do Q", { Im0: b });
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const { found } = await imagesOf(out);
  const refs = new Set(found.map((f) => f.ref.toString()));
  check("duplicates: one image left", refs.size === 1, [...refs]);
  check("duplicates: sized for the larger placement", near(dims(found[0].stream)[0], TARGET[0]), dims(found[0].stream));
}
{
  // An image inside a Form XObject scaled by its /Matrix, the form drawn twice.
  const doc = await PDFDocument.create();
  const im = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  const form = doc.context.register(
    doc.context.stream("q 2400 0 0 1600 0 0 cm /Im0 Do Q", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 0, 2400, 1600],
      Matrix: [0.125, 0, 0, 0.125, 0, 0],
      Resources: { XObject: { Im0: im } },
    } as never)
  );
  addPage(doc, [595, 842], "q 1 0 0 1 50 500 cm /Fm0 Do Q q 0.5 0 0 0.5 50 50 cm /Fm0 Do Q", { Fm0: form });
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const { found } = await imagesOf(out);
  check("form matrix: image sized for 300 × 200 pt", near(dims(found[0].stream)[0], TARGET[0]), dims(found[0].stream));
}
{
  // Rotated 90°: the image's x axis runs up the page.
  const doc = await PDFDocument.create();
  const im = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  addPage(doc, [595, 842], "q 0 300 -200 0 400 100 cm /Im0 Do Q", { Im0: im });
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const { found } = await imagesOf(out);
  const [w, h] = dims(found[0].stream);
  check("rotated: sized along the image's own axes", near(w, TARGET[0]) && near(h, TARGET[1]), [w, h]);
}

// ---------------------------------------------------------------------------
// 5. The content tokenizer
// ---------------------------------------------------------------------------
{
  const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  const binary = new Uint8Array([0x00, 0xff, 0x20, 0x45, 0x49, 0x20, 0x01, 0x02, 0x80, 0x45, 0x49, 0x9c, 0x20, 0x45, 0x49, 0x0a, 0x05]);
  const parts = [
    enc("BT /F1 12 Tf 72 700 Td (Do cm 9000 0 0 9000 0 0 cm /Im0 Do) Tj ET\n"),
    enc("BT (nested (parens \\) and \\( escapes 5000 0 0 5000 0 0 cm /Im0 Do) still) Tj ET\n"),
    enc("BT <2F496D3020446F> Tj [(a) -20 (Do)] TJ ET\n"),
    enc("% 8000 0 0 8000 0 0 cm /Im0 Do in a comment\n"),
    enc("BI /W 40 /H 1 /BPC 8 /CS /G ID EI 7000 0 0 7000 0 0 cm /Im0 Do Q q     EI\n"),
    enc("BI /W 17 /H 1 /BPC 8 /CS /G /F /Fl ID "),
    binary,
    enc(" EI\n"),
    enc("/Tag <</MCID 3 /Alt (cm Do)>> BDC EMC\n"),
    enc("q 300 0 0 200 50 50 cm /Im#30 Do Q\n"),
  ];
  const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((o, p) => (content.set(p, o), o + p.length), 0);
  const ops: string[] = [];
  scanContent(content, (op, args) => {
    if (op === "cm" || op === "Do") ops.push(`${args.join(" ")} ${op}`);
  });
  check("tokenizer: only the real cm and Do", JSON.stringify(ops) === JSON.stringify(["300 0 0 200 50 50 cm", "Im0 Do"]), ops);

  const doc = await PDFDocument.create();
  const im = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  const page = doc.addPage([595, 842]);
  page.node.setXObject(PDFName.of("Im0"), im);
  page.node.addContentStream(doc.context.register(doc.context.stream(content)));
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const { found } = await imagesOf(out);
  check("tokenizer: decoys don't change the image size", near(dims(found[0].stream)[0], TARGET[0]), dims(found[0].stream));
}

// ---------------------------------------------------------------------------
// 6. Gray pictures, and the rest of the document
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const gray = new Uint8Array(bigPhoto.length);
  for (let i = 0; i < gray.length; i += 3) gray[i] = gray[i + 1] = gray[i + 2] = bigPhoto[i + 1];
  const im = jpegImage(doc.context, BIG_W, BIG_H, await jpeg(gray, BIG_W, BIG_H, 92));
  addPage(doc, [595, 842], "q 300 0 0 200 50 50 cm /Im0 Do Q", { Im0: im });
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const { found } = await imagesOf(out);
  const s = found[0].stream;
  check("gray: stored as DeviceGray", s.dict.lookup(PDFName.of("ColorSpace")) === PDFName.of("DeviceGray"));
  check("gray: one-channel JPEG", jpegComponents(s.contents) === 1, jpegComponents(s.contents));
}
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const im = jpegImage(doc.context, BIG_W, BIG_H, bigJpeg);
  const page = addPage(doc, [595, 842], "q 300 0 0 200 50 300 cm /Im0 Do Q", { Im0: im });
  page.drawText("Visit the site", { x: 50, y: 700, size: 12, font });
  const context = doc.context;
  const link = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [50, 695, 150, 712],
      Border: [0, 0, 0],
      A: { S: "URI", URI: PDFString.of("https://example.com/") },
    })
  );
  page.node.addAnnot(link);
  const outlines = context.nextRef();
  const item = context.register(
    context.obj({ Title: PDFString.of("Chapter 1"), Parent: outlines, Dest: [page.ref, "XYZ", null, null, null] } as never)
  );
  context.assign(outlines, context.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  const field = doc.getForm().createTextField("name");
  field.addToPage(page, { x: 50, y: 600, width: 200, height: 24 });
  field.setText("Ada Lovelace");
  const out = await compressPdf(await doc.save(), { preset: "balanced" });
  const pdf = await pdfjsDoc(out);
  const annots = await (await pdf.getPage(1)).getAnnotations();
  const outline = await pdf.getOutline();
  const fields = await pdf.getFieldObjects();
  check("link: kept", annots.some((a: { subtype: string; url?: string }) => a.subtype === "Link" && a.url === "https://example.com/"));
  check("bookmarks: kept", outline?.[0]?.title === "Chapter 1", outline);
  check("form field: kept with its value", !!fields?.name?.some((f: { value?: unknown }) => f.value === "Ada Lovelace"), fields?.name);
  await pdf.destroy();
}

// ---------------------------------------------------------------------------
// 7. The tool: never bigger, friendly errors, old settings
// ---------------------------------------------------------------------------
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([595, 842]);
    for (let l = 0; l < 40; l++) page.drawText(`Line ${l + 1} of page ${p + 1}: plain text that should stay text.`, { x: 40, y: 800 - l * 19, size: 11, font });
  }
  const textOnly = await doc.save({ useObjectStreams: false });
  const result = await compressTool([file(textOnly, "notes.pdf")], { quality: "balanced" });
  check("text-only: never grows", result.blob.size <= textOnly.length, [textOnly.length, result.blob.size]);
  const again = await compressTool([new File([result.blob], result.filename)], { quality: "balanced" });
  check("text-only: no gain hands back the original", again.blob.size === result.blob.size && again.filename === result.filename.replace(/\.pdf$/, "") + ".pdf", [again.filename, again.blob.size]);

  const locked = await (async () => {
    const d = await SecurePDFDocument.load(textOnly);
    d.encrypt({ userPassword: "pw", ownerPassword: "pw" });
    return d.save({ useObjectStreams: false });
  })();
  let message = "";
  try {
    await compressTool([file(locked, "locked.pdf")], { quality: "balanced" });
  } catch (err) {
    message = (err as Error).message;
  }
  check("encrypted: friendly message", message === "This PDF is password-protected. Unlock it first.", message);

  // PDF/A-1 (PDF 1.4) has no object streams; a PDF/A-1 file keeps plain objects.
  const pdfa = await PDFDocument.load(textOnly);
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta>';
  pdfa.catalog.set(PDFName.of("Metadata"), pdfa.context.register(pdfa.context.stream(xmp, { Type: "Metadata", Subtype: "XML" })));
  const pdfaOut = new TextDecoder("latin1").decode(await compressPdf(await pdfa.save({ useObjectStreams: false }), { preset: "balanced" }));
  check("pdf/a-1: saved without object streams", !pdfaOut.includes("/ObjStm") && pdfaOut.includes("<pdfaid:part>1</pdfaid:part>"));
  const plainOut = new TextDecoder("latin1").decode(await compressPdf(textOnly, { preset: "balanced" }));
  check("other files: saved with object streams", plainOut.includes("/ObjStm"));

  check("old setting 0.4 → smallest", presetFrom("0.4") === "smallest");
  check("old setting 0.6 → balanced", presetFrom("0.6") === "balanced");
  check("old setting 0.8 → high", presetFrom("0.8") === "high");
}

// ---------------------------------------------------------------------------
// 8. Resampling and PNG predictors
// ---------------------------------------------------------------------------
{
  check("resample: pairs averaged", JSON.stringify([...resize(new Uint8Array([0, 100, 200, 255]), 4, 1, 1, 2, 1)]) === "[50,228]");
  check("resample: fractional coverage", JSON.stringify([...resize(new Uint8Array([0, 90, 180]), 3, 1, 1, 2, 1)]) === "[30,150]");
  check("resample: flat stays flat", resize(new Uint8Array(997 * 3 * 3).fill(77), 997, 3, 3, 331, 2).every((v) => v === 77));

  const w = 37;
  const h = 11;
  const px = photo(w, h, 9);
  const predicted = predictPng(px, w * 3, 3);
  const parms = PDFDocument.create().then((d) => d.context.obj({ Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: w }) as PDFDict);
  check("predictor: PNG round trip", sameBytes(unpredict(predicted, await parms)!, px));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
