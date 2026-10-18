// A digital PDF with little text (slides with a title each, a certificate,
// a poster) is not a scan. PDF to Word used to call it one when pages had
// under 40 characters on average and send it to OCR, which then refused it
// as already searchable: there was no way to convert it. A scan is a page
// with a picture and next to no text of its own.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { randomBytes } from "node:crypto";
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from "pdf-lib";
import { parseDocument } from "../lib/pdf/parse.ts";
import { pdfToWordTool } from "../lib/pdf/toolkit.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const file = (bytes: Uint8Array) => new File([bytes.slice() as unknown as BlobPart], "deck.pdf", { type: "application/pdf" });

/** Slide-sized pages, each with an optional title and an optional full-page picture. */
async function make(titles: (string | null)[], pictures: boolean) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.HelveticaBold);
  for (const title of titles) {
    const page = d.addPage([960, 540]);
    if (pictures) {
      const scan = PDFRawStream.of(
        d.context.obj({ Type: "XObject", Subtype: "Image", Width: 64, Height: 36, ColorSpace: "DeviceGray", BitsPerComponent: 8 }),
        randomBytes(64 * 36)
      );
      page.node.setXObject(PDFName.of("Scan"), d.context.register(scan));
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(960, 0, 0, 540, 0, 0), drawObject("Scan"), popGraphicsState());
    }
    if (title) page.drawText(title, { x: 60, y: 440, size: 44, font });
  }
  return d.save();
}

const titles = ["Welcome", "Our mission", "Q3 results", "Revenue up 12%", "New markets", "Team", "Roadmap", "Risks", "Next steps", "Thank you"];
const deck = await make(titles, false);
check("a deck of short titles is not a scan", !(await parseDocument(deck)).likelyScanned);
let word: unknown;
try {
  word = await pdfToWordTool([file(deck)]);
} catch (err) {
  word = (err as Error).message;
}
check("PDF to Word converts it", typeof word === "object" && (word as { filename: string }).filename === "deck.docx", word);

check("a scan with no text is a scan", (await parseDocument(await make([null, null, null], true))).likelyScanned);
check("a scan with a short stamp on each page is a scan", (await parseDocument(await make(["Scanned", "Scanned", "Scanned"], true))).likelyScanned);
check("a document with no text at all needs OCR", (await parseDocument(await make([null, null], false))).likelyScanned);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
