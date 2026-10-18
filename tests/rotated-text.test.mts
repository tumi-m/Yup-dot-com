// Text tools read the page as it is shown. A landscape page is often stored
// as a portrait one turned by /Rotate, with its text drawn sideways so it
// reads upright (LaTeX pdflscape, many printer drivers); a page can also be
// cut from a wider sheet (a CropBox that doesn't start at 0). Text, Markdown
// and the rest used to read such pages in the stored frame: lines fused,
// words scrambled and columns read as a table.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import {
  PDFDocument,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import { parseDocument, toMarkdown, toPlainText } from "../lib/pdf/parse.ts";
import { pageFrame } from "../lib/pdf/page-frame.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const LINES: [string, number][] = [
  ["Quarterly Report", 24],
  ["The first line of the body text runs across the landscape page.", 12],
  ["The second line continues the same paragraph without a break.", 12],
  ["The third line ends the paragraph here.", 12],
];
const EXPECTED =
  "Quarterly Report\n\nThe first line of the body text runs across the landscape page. The second line continues the same paragraph without a break. The third line ends the paragraph here.\n";

/** A portrait page turned by `rotation`, its text drawn so it reads upright, one word at a time or one line at a time. */
async function turned(rotation: number, wordByWord: boolean) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  const page = d.addPage([595, 842]);
  page.setRotation(degrees(rotation));
  const frame = pageFrame(page);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frame.matrix));
  let v = frame.height - 60;
  for (const [text, size] of LINES) {
    const f = size > 12 ? bold : font;
    let u = 60;
    for (const piece of wordByWord ? text.split(" ") : [text]) {
      page.drawText(piece, { x: u, y: v, size, font: f });
      u += f.widthOfTextAtSize(piece + " ", size);
    }
    v -= size * 1.6;
  }
  page.pushOperators(popGraphicsState());
  return d.save();
}

for (const rotation of [90, 180, 270]) {
  for (const wordByWord of [true, false]) {
    const parsed = await parseDocument(await turned(rotation, wordByWord));
    const text = toPlainText(parsed);
    check(`/Rotate ${rotation}, ${wordByWord ? "word by word" : "line by line"}: reads as shown`, text === EXPECTED, text);
    if (rotation === 90 && !wordByWord) {
      const md = toMarkdown(parsed);
      check("Markdown keeps the heading", md.startsWith("# Quarterly Report\n\nThe first line"), md);
    }
  }
}

// Two columns on the right half of a spread: the CropBox starts at x = 612.
async function spread(offset: number) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const page = d.addPage([612 + offset, 792]);
  page.setCropBox(offset, 0, 612, 792);
  for (let i = 0; i < 12; i++) {
    page.drawText(`Left column sentence number ${i + 1} here.`, { x: offset + 40, y: 700 - i * 16, size: 10, font });
    page.drawText(`Right column sentence number ${i + 1} too.`, { x: offset + 330, y: 700 - i * 16, size: 10, font });
  }
  return d.save();
}
for (const offset of [0, 612]) {
  const text = toPlainText(await parseDocument(await spread(offset)));
  check(
    `CropBox from x = ${offset}: left column, then right`,
    !text.includes("\t") && text.indexOf("Left column sentence number 12 here.") < text.indexOf("Right column sentence number 1 too."),
    text.slice(0, 120)
  );
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
