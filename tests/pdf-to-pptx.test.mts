process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { writePptx, xmlEscape, EMU_PER_PT, type PptxSlide } from "../lib/pptx/write.ts";
import {
  pdfToPptx,
  slideSizeFor,
  fitFrame,
  pageText,
  renderScale,
  MAX_CANVAS_PIXELS,
  type PageRasterizer,
} from "../lib/pptx/from-pdf.ts";

let passed = 0;
let total = 0;
function check(name: string, ok: boolean, extra = "") {
  total++;
  if (ok) passed++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${extra ? ` (${extra})` : ""}`);
}

const dir = mkdtempSync(join(tmpdir(), "pdf-to-pptx-"));
const hasSoffice = existsSync("/usr/bin/soffice") || existsSync("/usr/local/bin/soffice");

// ---------------------------------------------------------------------------
// Synthetic images
// ---------------------------------------------------------------------------

/** A real, minimal RGB PNG built by hand (no canvas needed). */
function makePng(w: number, h: number, rgbHex: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (rgbHex >> 16) & 255;
      raw[o + 1] = (rgbHex >> 8) & 255;
      raw[o + 2] = rgbHex & 255;
    }
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

/** An 8x8 baseline JPEG (violet with an amber quadrant). */
const JPEG = new Uint8Array(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDnfH/j/wD4Tn7B/oH2L7L5n/LbzN27b/sjGNv60UUV/WmSZJgOHcBTyvK6fs6NO/LG8pW5pOT1k23dtvV/gfbVq08RN1Kju2f/2Q==",
    "base64"
  )
);

// ---------------------------------------------------------------------------
// Package validation helpers
// ---------------------------------------------------------------------------

/** Every relationship target exists and every part has a content type. */
async function validatePackage(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const problems: string[] = [];
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const folders = Object.keys(zip.files).filter((n) => zip.files[n].dir);
  if (folders.length) problems.push(`folder entries in the zip: ${folders.slice(0, 3).join(", ")}`);
  if (names[0] !== "[Content_Types].xml") problems.push("[Content_Types].xml is not the first entry");
  const ct = await zip.file("[Content_Types].xml")!.async("string");
  const defaults = new Set([...ct.matchAll(/<Default Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/<Override PartName="([^"]+)"/g)].map((m) => m[1]));
  for (const o of overrides) if (!names.includes(o.slice(1))) problems.push(`override for missing part ${o}`);
  for (const name of names) {
    if (name === "[Content_Types].xml") continue;
    const ext = name.split(".").pop()!.toLowerCase();
    if (!overrides.has(`/${name}`) && !defaults.has(ext)) problems.push(`no content type for ${name}`);
  }
  for (const name of names.filter((n) => n.endsWith(".rels"))) {
    const xml = await zip.file(name)!.async("string");
    const srcDir = posix.dirname(posix.dirname(name)); // "ppt/_rels/x.rels" -> "ppt"
    const ids = new Set<string>();
    for (const m of xml.matchAll(/<Relationship ([^>]+)\/>/g)) {
      const id = /Id="([^"]+)"/.exec(m[1])![1];
      const target = /Target="([^"]+)"/.exec(m[1])![1];
      if (ids.has(id)) problems.push(`${name}: duplicate ${id}`);
      ids.add(id);
      const resolved = posix.normalize(posix.join(srcDir === "." ? "" : srcDir, target));
      if (!names.includes(resolved)) problems.push(`${name}: ${id} -> missing ${resolved}`);
    }
    // Every r:id / r:embed used by the part must be declared in its .rels.
    const part = posix.join(srcDir === "." ? "" : srcDir, posix.basename(name, ".rels"));
    if (zip.file(part)) {
      const partXml = await zip.file(part)!.async("string");
      for (const m of partXml.matchAll(/r:(?:id|embed)="([^"]+)"/g)) {
        if (!ids.has(m[1])) problems.push(`${part}: unresolved ${m[1]}`);
      }
    }
  }
  // Every XML part must be well-formed (python's expat is strict).
  const xmlParts = names.filter((n) => n.endsWith(".xml") || n.endsWith(".rels"));
  const dump = join(dir, "xmlcheck");
  rmSync(dump, { recursive: true, force: true });
  for (const n of xmlParts) {
    const p = join(dump, n);
    execFileSync("mkdir", ["-p", posix.dirname(p)]);
    writeFileSync(p, await zip.file(n)!.async("uint8array"));
  }
  const bad = execFileSync("python3", ["-c", `
import sys, os, xml.dom.minidom as m
bad = []
for root, _, files in os.walk(sys.argv[1]):
    for f in files:
        try: m.parse(os.path.join(root, f))
        except Exception as e: bad.append(f + ": " + str(e))
print("\\n".join(bad))
`, dump]).toString().trim();
  if (bad) problems.push(`malformed XML: ${bad}`);
  return problems;
}

interface PyReport {
  slides: number;
  width: number;
  height: number;
  pictures: { count: number; x: number; y: number; cx: number; cy: number; descr: string; type: string }[];
}

function readWithPythonPptx(path: string): PyReport {
  const out = execFileSync("python3", ["-c", `
import json, sys
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
p = Presentation(sys.argv[1])
pics = []
for s in p.slides:
    ps = [sh for sh in s.shapes if sh.shape_type == MSO_SHAPE_TYPE.PICTURE]
    f = ps[0] if ps else None
    pics.append({"count": len(ps), "x": f.left if f else 0, "y": f.top if f else 0,
                 "cx": f.width if f else 0, "cy": f.height if f else 0,
                 "descr": f._element.nvPicPr.cNvPr.get("descr", "") if f else "",
                 "type": f.image.content_type if f else ""})
print(json.dumps({"slides": len(p.slides), "width": p.slide_width, "height": p.slide_height, "pictures": pics}))
`, path]).toString();
  return JSON.parse(out);
}

/** Convert with LibreOffice; returns the PDF path. Uses a private profile so parallel runs don't clash. */
function libreOfficeToPdf(pptxPath: string): string {
  const profile = mkdtempSync(join(tmpdir(), "lo-profile-"));
  execFileSync(
    "soffice",
    [`-env:UserInstallation=file://${profile}`, "--headless", "--convert-to", "pdf", "--outdir", dir, pptxPath],
    { stdio: "pipe", timeout: 180_000 }
  );
  rmSync(profile, { recursive: true, force: true });
  return pptxPath.replace(/\.pptx$/, ".pdf");
}

async function pdfPageSizes(path: string): Promise<{ w: number; h: number }[]> {
  const doc = await PDFDocument.load(readFileSync(path));
  return doc.getPages().map((p) => p.getSize()).map(({ width, height }) => ({ w: width, h: height }));
}

// ---------------------------------------------------------------------------
// 1. Writer: 1, 3 and 40 slides
// ---------------------------------------------------------------------------

const W = 12192000; // 13.333 in (16:9)
const H = 6858000; // 7.5 in
for (const count of [1, 3, 40]) {
  const slides: PptxSlide[] = Array.from({ length: count }, (_, i) =>
    i % 2 === 0
      ? { image: makePng(64, 36, 0x7c3aed + i), format: "png", altText: `Slide ${i + 1} <&> "quoted"\nline two` }
      : { image: JPEG, format: "jpeg", frame: { x: 3429000, y: 0, cx: 5334000, cy: H } }
  );
  const bytes = await writePptx({ width: W, height: H, slides, title: `Deck ${count}`, date: new Date("2026-01-02T03:04:05Z") });
  const path = join(dir, `deck-${count}.pptx`);
  writeFileSync(path, bytes);

  const problems = await validatePackage(bytes);
  check(`${count}-slide deck: relationships resolve, parts typed, XML well-formed`, problems.length === 0, problems.slice(0, 5).join("; "));

  const r = readWithPythonPptx(path);
  check(`${count}-slide deck: python-pptx sees ${count} slides`, r.slides === count, `got ${r.slides}`);
  check(`${count}-slide deck: slide size`, r.width === W && r.height === H, `${r.width}x${r.height}`);
  check(
    `${count}-slide deck: one picture per slide with the right frame and type`,
    r.pictures.every((p, i) =>
      p.count === 1 &&
      (i % 2 === 0
        ? p.x === 0 && p.y === 0 && p.cx === W && p.cy === H && p.type === "image/png"
        : p.x === 3429000 && p.cx === 5334000 && p.type === "image/jpeg")
    )
  );
  if (count === 3) {
    check("alt text survives escaping (quotes, <&>, newline)", r.pictures[0].descr === 'Slide 1 <&> "quoted"\nline two', JSON.stringify(r.pictures[0].descr));
  }
  if (count !== 1 && hasSoffice) {
    const pdfPath = libreOfficeToPdf(path);
    const pages = await pdfPageSizes(pdfPath);
    check(`${count}-slide deck: LibreOffice renders ${count} pages`, pages.length === count, `got ${pages.length}`);
    check(
      `${count}-slide deck: LibreOffice page size matches slide size`,
      Math.abs(pages[0].w - W / EMU_PER_PT) < 1 && Math.abs(pages[0].h - H / EMU_PER_PT) < 1,
      `${pages[0].w.toFixed(1)}x${pages[0].h.toFixed(1)}`
    );
  }
}
if (!hasSoffice) console.log("SKIP: LibreOffice not installed; conversion checks not run");

// Slide size is clamped to PowerPoint's 1–56 inch range.
{
  const bytes = await writePptx({ width: 10, height: 1e12, slides: [{ image: JPEG, format: "jpeg" }] });
  const pres = await (await JSZip.loadAsync(bytes)).file("ppt/presentation.xml")!.async("string");
  check("writer clamps sldSz to 1–56 in", pres.includes('<p:sldSz cx="914400" cy="51206400"/>'));
}
check("xmlEscape drops XML-illegal control characters", xmlEscape("a\u0001b\u0000c&") === "abc&amp;");

// ---------------------------------------------------------------------------
// 2. Pure helpers of the PDF conversion
// ---------------------------------------------------------------------------

const letter = slideSizeFor(612, 792);
check("slide size: US Letter is 8.5x11 in", letter.cx === 7772400 && letter.cy === 10058400, JSON.stringify(letter));
const huge = slideSizeFor(200 * 72, 100 * 72);
check("slide size: 200x100 in page shrinks to 56x28 in", huge.cx === 51206400 && huge.cy === 25603200, JSON.stringify(huge));
const tiny = slideSizeFor(36, 18);
check("slide size: 0.5x0.25 in page grows to 2x1 in", tiny.cx === 1828800 && tiny.cy === 914400, JSON.stringify(tiny));
const f = fitFrame(792, 612, 7772400, 10058400);
check(
  "fitFrame letterboxes a landscape page on a portrait slide, centred",
  f.x === 0 && f.cx === 7772400 && Math.abs(f.cy - 6005945) <= 1 && Math.abs(f.y * 2 + f.cy - 10058400) <= 1,
  JSON.stringify(f)
);
const s = renderScale(14400, 14400, 220);
check("renderScale caps huge pages below the canvas pixel limit", (14400 * s) ** 2 <= MAX_CANVAS_PIXELS + 1, s.toFixed(3));
check("renderScale keeps the requested DPI for normal pages", Math.abs(renderScale(612, 792, 150) - 150 / 72) < 1e-9);
const txt = pageText([
  { str: "Title", transform: [20, 0, 0, 20, 50, 700] },
  { str: "Body", transform: [11, 0, 0, 11, 50, 660] },
  { str: "text", transform: [11, 0, 0, 11, 80, 660] },
  { str: "", hasEOL: true },
  { str: "  next   line ", transform: [11, 0, 0, 11, 50, 645] },
]);
check("pageText keeps reading order with line breaks", txt === "Title\nBody text\nnext line", JSON.stringify(txt));
const long = pageText([{ str: "word ".repeat(1000), transform: [10, 0, 0, 10, 0, 0] }], 200);
check("pageText caps long text at a word boundary", long.length <= 200 && long.endsWith("…") && !long.includes("wor…"), `${long.length}`);

// ---------------------------------------------------------------------------
// 3. End to end: PDF -> PPTX in Node (pdf.js + node-canvas)
// ---------------------------------------------------------------------------

let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
} catch {
  console.log("SKIP: node-canvas unavailable; end-to-end PDF conversion not run in Node");
}

if (canvasMod) {
  const { createCanvas } = canvasMod;
  const FONTS = "./node_modules/pdfjs-dist/standard_fonts/";
  const nodeRasterizer: PageRasterizer = async (page, scale, q) => {
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(vp.width), Math.round(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
    return new Uint8Array(canvas.toBuffer("image/jpeg", { quality: q }));
  };

  // Portrait letter, landscape letter, and a portrait page stored with /Rotate 90.
  const src = await PDFDocument.create();
  const helv = await src.embedFont(StandardFonts.Helvetica);
  const bold = await src.embedFont(StandardFonts.HelveticaBold);
  const p1 = src.addPage([612, 792]);
  p1.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: rgb(0.43, 0.16, 0.85) });
  p1.drawText("Quarterly Review", { x: 50, y: 730, size: 32, font: bold, color: rgb(1, 1, 1) });
  p1.drawText("Revenue grew in every region.", { x: 50, y: 640, size: 16, font: helv });
  p1.drawRectangle({ x: 50, y: 300, width: 200, height: 200, color: rgb(0.96, 0.62, 0.04) });
  const p2 = src.addPage([792, 612]);
  p2.drawText("Landscape roadmap", { x: 50, y: 540, size: 28, font: bold });
  p2.drawRectangle({ x: 50, y: 100, width: 692, height: 300, color: rgb(0.85, 0.27, 0.94) });
  const p3 = src.addPage([612, 792]);
  p3.drawText("Rotated page", { x: 50, y: 700, size: 24, font: bold });
  p3.setRotation(degrees(90));
  const pdfBytes = await src.save();
  writeFileSync(join(dir, "source.pdf"), pdfBytes);

  const progress: number[] = [];
  const pptx = await pdfToPptx(pdfBytes, {
    quality: "standard",
    title: "source",
    rasterize: nodeRasterizer,
    standardFontDataUrl: FONTS,
    onProgress: (fr) => progress.push(fr),
  });
  const out = join(dir, "from-pdf.pptx");
  writeFileSync(out, pptx);

  const problems = await validatePackage(pptx);
  check("PDF->PPTX: package is valid", problems.length === 0, problems.slice(0, 5).join("; "));
  const r = readWithPythonPptx(out);
  check("PDF->PPTX: one slide per page", r.slides === 3, `got ${r.slides}`);
  check("PDF->PPTX: slide size = first page (8.5x11 in)", r.width === 7772400 && r.height === 10058400, `${r.width}x${r.height}`);
  check("PDF->PPTX: page 1 is full-bleed", r.pictures[0].x === 0 && r.pictures[0].cx === 7772400 && r.pictures[0].cy === 10058400);
  const land = r.pictures[1];
  check(
    "PDF->PPTX: landscape page letterboxed and centred",
    land.x === 0 && land.cx === 7772400 && land.cy < 7000000 && Math.abs(land.y * 2 + land.cy - 10058400) <= 2,
    JSON.stringify(land)
  );
  check("PDF->PPTX: rotated page treated as landscape", r.pictures[2].cy < 7000000, JSON.stringify(r.pictures[2]));
  check(
    "PDF->PPTX: page text in alt text, in reading order",
    r.pictures[0].descr === "Quarterly Review\nRevenue grew in every region." && r.pictures[1].descr === "Landscape roadmap",
    JSON.stringify(r.pictures.map((p) => p.descr))
  );
  check("PDF->PPTX: pictures are JPEG", r.pictures.every((p) => p.type === "image/jpeg"));
  check(
    "PDF->PPTX: progress reported per page and finishes at 1",
    progress.length >= 4 && progress[progress.length - 1] === 1 && progress.every((v, i) => i === 0 || v >= progress[i - 1]),
    JSON.stringify(progress.map((v) => +v.toFixed(2)))
  );
  const media = (await JSZip.loadAsync(pptx)).file("ppt/media/image1.jpeg")!;
  const img1 = await media.async("nodebuffer");
  const sof = img1.indexOf(Buffer.from([0xff, 0xc0]));
  const pxH = img1.readUInt16BE(sof + 5);
  const pxW = img1.readUInt16BE(sof + 7);
  check("PDF->PPTX: standard quality renders at 150 DPI", pxW === 1275 && pxH === 1650, `${pxW}x${pxH}`);

  const hi = await pdfToPptx(pdfBytes, { quality: "high", rasterize: nodeRasterizer, standardFontDataUrl: FONTS });
  const hiImg = await (await JSZip.loadAsync(hi)).file("ppt/media/image1.jpeg")!.async("nodebuffer");
  const hsof = hiImg.indexOf(Buffer.from([0xff, 0xc0]));
  check("PDF->PPTX: high quality renders at 220 DPI", hiImg.readUInt16BE(hsof + 7) === 1870, `${hiImg.readUInt16BE(hsof + 7)}px wide`);

  if (hasSoffice) {
    const lo = libreOfficeToPdf(out);
    const pages = await pdfPageSizes(lo);
    check("PDF->PPTX: LibreOffice renders 3 pages at 612x792", pages.length === 3 && Math.abs(pages[0].w - 612) < 1 && Math.abs(pages[0].h - 792) < 1, JSON.stringify(pages));

    // Visual comparison: render source page 1 and the LibreOffice page 1, compare pixels.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC!;
    const renderGray = async (bytes: Uint8Array, pageNo: number) => {
      const d = await pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: FONTS }).promise;
      const pg = await d.getPage(pageNo);
      const vp = pg.getViewport({ scale: 0.5 });
      const c = createCanvas(Math.round(vp.width), Math.round(vp.height));
      const cx = c.getContext("2d");
      cx.fillStyle = "#fff";
      cx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: cx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
      writeFileSync(join(dir, `cmp-${pageNo}-${bytes.length}.png`), c.toBuffer("image/png"));
      const px = cx.getImageData(0, 0, c.width, c.height).data;
      await d.destroy();
      return { px, w: c.width, h: c.height };
    };
    const a = await renderGray(pdfBytes, 1);
    const b = await renderGray(new Uint8Array(readFileSync(lo)), 1);
    let diff = 0;
    const n = Math.min(a.px.length, b.px.length);
    for (let i = 0; i < n; i += 4) diff += Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]);
    const mean = diff / (n / 4) / 3;
    check("PDF->PPTX: LibreOffice rendering of slide 1 matches the source page", a.w === b.w && a.h === b.h && mean < 6, `mean abs diff ${mean.toFixed(2)}/255`);
  }

  // Password-protected PDFs get a clear message, not a crash.
  const { protectPdf } = await import("../lib/pdf/security.ts");
  const locked = await protectPdf(pdfBytes, { userPassword: "secret", allowPrinting: true, allowCopying: true });
  let msg = "";
  try {
    await pdfToPptx(locked, { rasterize: nodeRasterizer });
  } catch (e) {
    msg = (e as Error).message;
  }
  check("PDF->PPTX: password-protected PDF is refused with a clear message", /password-protected/i.test(msg), msg);
}

console.log(`\nartifacts in ${dir}`);
console.log(`${passed}/${total} passed`);
process.exit(passed === total ? 0 : 1);
