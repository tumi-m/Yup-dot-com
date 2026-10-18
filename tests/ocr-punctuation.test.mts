process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// The searchable text layer (OCR PDF, PPTX to PDF) keeps words with curly
// quotes, dashes, € and œ: Word and PowerPoint text is full of them, and the
// standard fonts' WinAnsi encoding has them all.
import { PDFDocument } from "pdf-lib";
import { addTextLayer, buildSearchablePdf, type OcrText } from "../lib/pdf/ocr-layer.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const TYPED = ["We", "don’t", "ship", "on", "Sunday", "—", "it’s", "‘closed’.", "Price", "€250", "for", "the", "“premium”", "plan…", "Œuvre", "and", "œuvre", "–", "Ÿ", "™"];
// Outside WinAnsi: left out, without losing the rest.
const OTHER = ["Łódź", "日本"];

/** Eight words to a row, on a 2x render of a 600 x 400 pt page. */
function wordsOn(texts: string[]): OcrText {
  return {
    widthPt: 600,
    heightPt: 400,
    imageWidth: 1200,
    imageHeight: 800,
    words: texts.map((text, i) => {
      const x0 = 40 + (i % 8) * 140;
      const y0 = 60 + Math.floor(i / 8) * 80;
      return { text, x0, y0, x1: x0 + 120, y1: y0 + 40, confidence: 90 };
    }),
  };
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
async function layerWords(bytes: Uint8Array): Promise<string[]> {
  const d = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const items = (await (await d.getPage(1)).getTextContent()).items as { str: string }[];
  await d.destroy();
  return items.flatMap((it) => it.str.split(/\s+/)).filter(Boolean);
}

const src = wordsOn([...TYPED, ...OTHER]);

// On an existing PDF (OCR PDF).
const doc = await PDFDocument.create();
doc.addPage([600, 400]);
const onOriginal = await layerWords(await addTextLayer(doc, [src]));
for (const w of TYPED) check(`addTextLayer keeps "${w}"`, onOriginal.includes(w), onOriginal);
check("addTextLayer leaves out words the font can't encode", !OTHER.some((w) => onOriginal.includes(w)), onOriginal);

// On pages rebuilt from images (PPTX to PDF, PDFs that can't be edited).
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);
const rebuilt = await layerWords(await buildSearchablePdf([{ ...src, imageType: "png", image: png }]));
check("buildSearchablePdf keeps every WinAnsi word", TYPED.every((w) => rebuilt.includes(w)), rebuilt);
check("buildSearchablePdf leaves out words the font can't encode", !OTHER.some((w) => rebuilt.includes(w)), rebuilt);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
