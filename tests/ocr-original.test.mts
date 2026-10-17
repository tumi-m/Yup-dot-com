process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// OCR on a PDF keeps the original pages and only adds invisible words. Each
// word must land where it was read on the page *as displayed*, also on pages
// with /Rotate and with CropBox/MediaBox that don't start at 0,0.
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { addTextLayer, textAgrees, type OcrText } from "../lib/pdf/ocr-layer.ts";
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

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
