process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// OCR on a PDF keeps the original pages and only adds invisible words. Each
// word must land where it was read on the page *as displayed*, also on pages
// with /Rotate and with CropBox/MediaBox that don't start at 0,0.
import { PDFDocument, StandardFonts, degrees, drawObject, popGraphicsState, pushGraphicsState, concatTransformationMatrix, rgb } from "pdf-lib";
import { addTextLayer, looksGarbled, newWords, textAgrees, type OcrText, type OwnText } from "../lib/pdf/ocr-layer.ts";
import { ownText, showsPictures } from "../lib/pdf/page-content.ts";
import { pageFrame, visibleBox } from "../lib/pdf/page-frame.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

interface PageSpec {
  name: string;
  media: [number, number, number, number];
  crop?: [number, number, number, number];
  rotate: number;
}
const SPECS: PageSpec[] = [
  { name: "plain letter", media: [0, 0, 612, 792], rotate: 0 },
  { name: "rotated 90", media: [0, 0, 612, 792], rotate: 90 },
  { name: "rotated 180", media: [0, 0, 612, 792], rotate: 180 },
  { name: "rotated 270", media: [0, 0, 612, 792], rotate: 270 },
  { name: "cropped", media: [0, 0, 612, 792], crop: [40, 60, 560, 700], rotate: 0 },
  { name: "cropped + rotated 90", media: [0, 0, 612, 792], crop: [40, 60, 560, 700], rotate: 90 },
  { name: "offset MediaBox + rotated 270", media: [100, 200, 712, 992], crop: [150, 260, 650, 900], rotate: 270 },
  { name: "CropBox past the MediaBox", media: [0, 0, 500, 600], crop: [-50, -50, 450, 650], rotate: 180 },
];

// Source: one page per spec with real text and a picture-like rectangle.
const src = await PDFDocument.create();
const helv = await src.embedFont(StandardFonts.Helvetica);
for (const spec of SPECS) {
  const [x0, y0, x1, y1] = spec.media;
  const page = src.addPage([x1 - x0, y1 - y0]);
  page.setMediaBox(x0, y0, x1 - x0, y1 - y0);
  if (spec.crop) page.setCropBox(spec.crop[0], spec.crop[1], spec.crop[2] - spec.crop[0], spec.crop[3] - spec.crop[1]);
  page.setRotation(degrees(spec.rotate));
  page.drawRectangle({ x: x0 + 100, y: y0 + 300, width: 200, height: 100, color: rgb(0.2, 0.4, 0.8) });
  page.drawText("Original", { x: x0 + 120, y: y0 + 500, size: 14, font: helv });
}
const original = await src.save();

// "OCR results": words at fixed spots of a 2x render of each displayed page.
const SCALE = 2;
const WORDS = [
  { text: "Invoice", u: 60, v: 80, w: 90, h: 24 }, // displayed points, top-left origin
  { text: "Total", u: 200, v: 300, w: 60, h: 16 },
];
const loaded = await PDFDocument.load(original);
const ocr: (OcrText | null)[] = loaded.getPages().map((page, i) => {
  if (SPECS[i].name === "rotated 180") return null; // a page left alone
  const frame = pageFrame(page, visibleBox(page));
  return {
    widthPt: frame.width,
    heightPt: frame.height,
    imageWidth: Math.round(frame.width * SCALE),
    imageHeight: Math.round(frame.height * SCALE),
    words: WORDS.map((w) => ({
      text: w.text,
      x0: w.u * SCALE,
      y0: w.v * SCALE,
      x1: (w.u + w.w) * SCALE,
      y1: (w.v + w.h) * SCALE,
      confidence: 90,
    })),
  };
});
const out = await addTextLayer(loaded, ocr);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const doc = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
check("same number of pages", doc.numPages === SPECS.length, doc.numPages);
for (let i = 0; i < SPECS.length; i++) {
  const spec = SPECS[i];
  const page = await doc.getPage(i + 1);
  const vp = page.getViewport({ scale: 1 });
  const items = (await page.getTextContent()).items as { str: string; transform: number[] }[];
  check(`${spec.name}: original text is still there`, items.some((it) => it.str === "Original"));
  const ops = await page.getOperatorList();
  const images = ops.fnArray.filter((f: number) => f === pdfjs.OPS.paintImageXObject).length;
  check(`${spec.name}: page not turned into an image`, images === 0, images);
  if (!ocr[i]) {
    check(`${spec.name}: skipped page gets no OCR words`, !items.some((it) => /Invoice|Total/.test(it.str)));
    continue;
  }
  for (const w of WORDS) {
    const it = items.find((x) => x.str.trim() === w.text);
    if (!it) {
      check(`${spec.name}: "${w.text}" is in the text layer`, false, items.map((x) => x.str));
      continue;
    }
    const [a, b, , , e, f] = it.transform;
    const [px, py] = vp.convertToViewportPoint(e, f);
    // Baseline: left edge of the word, 20% of its height above the box bottom.
    const want = { x: w.u, y: w.v + w.h - w.h * 0.2 };
    const along = vp.convertToViewportPoint(e + a, f + b);
    const upright = Math.abs(along[1] - py) < 1e-6 && along[0] > px;
    const ok = Math.abs(px - want.x) < 0.5 && Math.abs(py - want.y) < 0.5 && upright;
    check(`${spec.name}: "${w.text}" sits where it was read, reading left to right`, ok, { got: [px, py], want, upright });
  }
}

// The text layer adds a few kilobytes, not a re-rendered page.
check("output is the original plus a small text layer", out.length < original.length + 8000, { original: original.length, out: out.length });

// Agreement test: real text vs garbled text.
const read = [{ text: "Quarterly" }, { text: "revenue" }, { text: "grew" }, { text: "in" }, { text: "every" }, { text: "region." }];
check("textAgrees: real page text agrees with OCR", textAgrees(read, "Quarterly revenue grew in every region, says the report."));
check("textAgrees: garbled page text does not", !textAgrees(read, "Qxbtsfsmz sfwfovf hsfx jo fwfsz sfhjpo."));
check("textAgrees: OCR found nothing to compare", textAgrees([], "anything"));
check("looksGarbled: control and private-use characters", looksGarbled("\u0001\u0002\u0003\uE001\uE002 abc") && !looksGarbled("Quarterly revenue grew.") && !looksGarbled(""));

// --- Which OCR'd words are new ----------------------------------------------
// The page's own text, where pdf.js finds it (displayed points from the top-left).
{
  const page = await doc.getPage(1); // "plain letter"
  const own = await ownText(page);
  const orig = own.find((t) => t.text === "Original");
  // Drawn at x 120, baseline y 500 (from the bottom of a 792 pt page), 14 pt Helvetica.
  const width = helv.widthOfTextAtSize("Original", 14);
  const want = { x0: 120, y0: 792 - 500 - 14, x1: 120 + width, y1: 792 - 500 + 14 / 4 };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  check("ownText: a word's box on an upright page", !!orig && near(orig.x0, want.x0) && near(orig.y0, want.y0) && near(orig.x1, want.x1) && near(orig.y1, want.y1), { orig, want });
}
// On rotated and cropped pages the box must sit where the word shows.
for (let i = 0; i < SPECS.length; i++) {
  const spec = SPECS[i];
  const page = await doc.getPage(i + 1);
  const orig = (await ownText(page)).find((t) => t.text === "Original");
  // Where pdf-lib's page frame puts the word's corners on the displayed page.
  const frame = pageFrame(loaded.getPage(i), visibleBox(loaded.getPage(i)));
  const [x0, y0] = spec.media;
  const width = helv.widthOfTextAtSize("Original", 14);
  const corners = [
    [x0 + 120, y0 + 500 - 14 / 4],
    [x0 + 120 + width, y0 + 500 + 14],
  ].flatMap(([x, y]) => [frame.toDisplay(x, y), frame.toDisplay(x + (x === x0 + 120 ? width : -width), y)]);
  const us = corners.map((c) => c.u);
  const vs = corners.map((c) => frame.height - c.v);
  const want = { x0: Math.min(...us), y0: Math.min(...vs), x1: Math.max(...us), y1: Math.max(...vs) };
  const ok = !!orig && [["x0", "x0"], ["y0", "y0"], ["x1", "x1"], ["y1", "y1"]].every(([a, b]) => Math.abs(orig[a as "x0"] - want[b as "x0"]) < 0.5);
  check(`ownText: ${spec.name}: the box sits where the word shows`, ok, { orig, want });
}

/** OCR results for a 612 x 792 page rendered at 2x: words at displayed points. */
function readOn(words: { text: string; u: number; v: number; w: number; h: number }[]): OcrText {
  return {
    widthPt: 612,
    heightPt: 792,
    imageWidth: 1224,
    imageHeight: 1584,
    words: words.map((w) => ({ text: w.text, x0: w.u * 2, y0: w.v * 2, x1: (w.u + w.w) * 2, y1: (w.v + w.h) * 2, confidence: 90 })),
  };
}
const ownPieces: OwnText[] = [
  { text: "Invoice number 88213", font: "F1", x0: 72, y0: 90, x1: 260, y1: 108 },
  { text: "approved by the warehouse", font: "F1", x0: 72, y0: 120, x1: 300, y1: 138 },
  { text: "Gr#qf$ Wr|dx", font: "F2", x0: 72, y0: 400, x1: 200, y1: 418 },
];
const ocrRead = readOn([
  { text: "Invoice", u: 72, v: 92, w: 50, h: 14 }, // on real text
  { text: "number", u: 126, v: 92, w: 50, h: 14 },
  { text: "88213", u: 180, v: 92, w: 40, h: 14 },
  { text: "approved", u: 72, v: 122, w: 60, h: 14 },
  { text: "by", u: 136, v: 122, w: 14, h: 14 },
  { text: "tbe", u: 154, v: 122, w: 24, h: 14 }, // misread, but on real text: still a duplicate
  { text: "warehouse", u: 182, v: 122, w: 70, h: 14 },
  { text: "Signed", u: 300, v: 600, w: 50, h: 14 }, // in a scanned signature: no text there
  { text: "Bartholomew", u: 354, v: 600, w: 90, h: 14 },
  { text: "Quarterly", u: 72, v: 402, w: 60, h: 14 }, // on garbled text
  { text: "report", u: 136, v: 402, w: 50, h: 14 },
]);
const added = newWords(ocrRead, ownPieces).map((w) => w.text);
check("newWords: words on the page's own text are left out", !added.some((w) => ["Invoice", "number", "88213", "approved", "by", "tbe", "warehouse"].includes(w)), added);
check("newWords: words on a picture are added", added.includes("Signed") && added.includes("Bartholomew"), added);
check("newWords: words on garbled text are added", added.includes("Quarterly") && added.includes("report"), added);
check("newWords: a page with no text of its own keeps every word", newWords(ocrRead, []).length === ocrRead.words.length);

// --- Which pages show pictures -----------------------------------------------
{
  // A 2 x 2 RGB PNG.
  const pngBytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"));
  const pics = await PDFDocument.create();
  const png = await pics.embedPng(pngBytes);
  const text = (p: ReturnType<typeof pics.addPage>) => p.drawText("Some text of its own on this page", { x: 72, y: 700, size: 12 });
  text(pics.addPage([612, 792])); // 1: text only
  const p2 = pics.addPage([612, 792]);
  text(p2);
  p2.drawImage(png, { x: 72, y: 300, width: 200, height: 60 }); // 2: a signature-sized picture
  const p3 = pics.addPage([612, 792]);
  text(p3);
  p3.drawImage(png, { x: 72, y: 300, width: 12, height: 12 }); // 3: an icon
  const p4 = pics.addPage([612, 792]);
  text(p4);
  // 4: a big picture drawn inside a shrinking transform: 300 x 300 at 1/20 is an icon.
  const name = p4.node.newXObject("Image", png.ref);
  p4.pushOperators(pushGraphicsState(), concatTransformationMatrix(0.05, 0, 0, 0.05, 72, 72), concatTransformationMatrix(300, 0, 0, 300, 0, 0), drawObject(name), popGraphicsState());
  const p5 = pics.addPage([612, 792]);
  text(p5);
  // 5: a picture inside a form XObject (an embedded page) scaled up.
  const inner = await PDFDocument.create();
  const innerPng = await inner.embedPng(pngBytes);
  inner.addPage([100, 100]).drawImage(innerPng, { x: 0, y: 0, width: 50, height: 50 });
  const [form] = await pics.embedPdf(await inner.save());
  p5.drawPage(form, { x: 100, y: 100, xScale: 3, yScale: 3 });
  const pdf = await pdfjs.getDocument({ data: (await pics.save()).slice(), verbosity: 0 }).promise;
  const shows: boolean[] = [];
  for (let i = 1; i <= pdf.numPages; i++) shows.push(await showsPictures(await pdf.getPage(i), pdfjs.OPS as unknown as Record<string, number>));
  check("showsPictures: text only, signature, icon, shrunk picture, picture in a form", JSON.stringify(shows) === "[false,true,false,false,true]", shows);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
