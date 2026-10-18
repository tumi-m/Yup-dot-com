// A digital PDF with little text per page (a slide deck with a title on each
// slide) was taken for a scan: Chat with PDF refused it with "Run OCR PDF
// first", and OCR skips text a page already has, so there was no way on.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocument } from "../lib/pdf/parse.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

/** One page per entry: its text, or "" for a page with none (like a scanned image). */
async function pdf(pages: string[], size: [number, number] = [960, 540]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage(size);
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
