process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseDocument, toPlainText } from "../lib/pdf/parse.ts";

// Two-column page: naive stream-order extraction interleaves the columns.
const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const helv = await doc.embedFont(StandardFonts.Helvetica);

const LEFT = [
  "Alpha one begins the left column",
  "Alpha two continues the thought",
  "Alpha three closes the left side",
  "Alpha four is the final left line",
];
const RIGHT = [
  "Beta one starts the right column",
  "Beta two adds more detail here",
  "Beta three wraps the right side",
  "Beta four ends the right column",
];

// Interleave the draw order (left line, right line, ...) so stream order is wrong.
let y = 700;
for (let i = 0; i < LEFT.length; i++) {
  page.drawText(LEFT[i], { x: 55, y, size: 11, font: helv, color: rgb(0, 0, 0) });
  page.drawText(RIGHT[i], { x: 320, y, size: 11, font: helv, color: rgb(0, 0, 0) });
  y -= 16;
}

const parsed = await parseDocument(await doc.save());
const text = toPlainText(parsed).replace(/\s+/g, " ").trim();
console.log("OUTPUT:\n" + text + "\n");

const firstBeta = text.indexOf("Beta one");
const lastAlpha = text.lastIndexOf("Alpha four");
const ok = lastAlpha < firstBeta && firstBeta !== -1 && lastAlpha !== -1;
console.log(ok
  ? "PASS: all left-column lines precede the right column (reading order recovered)"
  : "FAIL: columns are interleaved");
process.exit(ok ? 0 : 1);
