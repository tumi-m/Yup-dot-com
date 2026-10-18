// A digital PDF with little text per page (a slide deck with a title on each
// slide) was taken for a scan: Chat with PDF refused it with "Run OCR PDF
// first", and OCR skips text a page already has, so there was no way on.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocument } from "../lib/pdf/parse.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

/** A small grey PNG, standing in for a scanned page's picture. */
function greyPng(w = 64, h = 48): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w + 1) + 1 + x] = (x * 7 + y * 3) & 255;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** One page per entry: its text, or "" for a page that is only a picture (like a scan). */
async function pdf(pages: string[], size: [number, number] = [960, 540]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const scan = await doc.embedPng(greyPng());
  for (const text of pages) {
    const page = doc.addPage(size);
    if (!text) page.drawImage(scan, { x: 0, y: 0, width: size[0], height: size[1] });
    text.split("\n").forEach((line, i) => page.drawText(line, { x: 60, y: size[1] - 80 - i * 16, size: 12, font }));
  }
  return doc.save();
}
const scanned = async (pages: string[]) => (await parseDocument(await pdf(pages))).likelyScanned;

check("a deck with a title per slide is not a scan", !(await scanned(["Quarterly Review", "Numbers"])));
check("a one-slide title is not a scan", !(await scanned(["Thank you"])));
check("a 20-slide deck of short titles is not a scan",
  !(await scanned(Array.from({ length: 20 }, (_, i) => `Slide ${i + 1}`))));
check("a few empty image slides don't make a deck a scan",
  !(await scanned(["Agenda", "", "Results", "", "Questions"])));

check("pages with no text at all are a scan", await scanned(["", "", ""]));
check("a scan behind a short typed cover page is still a scan",
  await scanned(["Fax cover: to the accounts team, 12 pages", "", "", "", "", "", "", "", "", ""]));
check("a text document is not a scan",
  !(await scanned(["The quarterly revenue grew steadily across all three regions.\n".repeat(6), "More text on page two about costs and hiring plans."])));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll scan detection checks passed.");
