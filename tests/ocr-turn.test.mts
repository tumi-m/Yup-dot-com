process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// A scanner's feeder takes pages in any way up. OCR PDF read an upside-down
// page as noise ("GN ANI ST nn WOT") and laid that over it. A page with no
// text of its own that reads badly is read again turned; the best read is
// kept, the page is turned in the file to match, and the result says so.
import { createRequire } from "node:module";
import { PDFDocument, rgb } from "pdf-lib";
import { leavesBehind, readQuality, readsBadly, readsBetter } from "../lib/pdf/ocr-layer.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

// The measure, on reads like Tesseract's of an upright and an upside-down invoice.
const upright = readQuality([
  { text: "TAX", confidence: 96 }, { text: "INVOICE", confidence: 95 }, { text: "Karoo", confidence: 93 },
  { text: "Pixel", confidence: 96 }, { text: "Studio", confidence: 96 }, { text: "(Pty)", confidence: 88 },
]);
const noise = readQuality([
  { text: "‘GN", confidence: 31 }, { text: "ANI", confidence: 42 }, { text: "ST", confidence: 22 },
  { text: "nn", confidence: 18 }, { text: "WOT", confidence: 35 }, { text: "aaissa", confidence: 25 }, { text: "fen", confidence: 71 }, { text: "Wwesl", confidence: 12 },
]);
check("an upright page reads well", !readsBadly(upright), upright);
check("an upside-down page reads badly", readsBadly(noise), noise);
check("the turned read wins only when it is clearly better", readsBetter(upright, noise) && !readsBetter(noise, upright));
check("a page with next to no text isn't turned", !readsBadly(readQuality([{ text: "x", confidence: 10 }])));

// A page 600 x 800 px: an upright title at the top over a table lying
// sideways. Turned 270°, the table reads well but the title is noise.
const box = (text: string, confidence: number, x0: number, y0: number, x1: number, y1: number) => ({ text, confidence, x0, y0, x1, y1 });
const title = [box("Appendix", 95, 50, 40, 200, 70), box("B", 95, 210, 40, 230, 70)];
// The table's words in the turned picture (800 x 600): across its lower part.
const table = [0, 1, 2, 3, 4].map((r) => box("Consulting", 95, 200, 200 + r * 60, 400, 230 + r * 60));
check("an upright title the turned reading has nothing for keeps the page as it lies", leavesBehind(title, table, 270, 600, 800));
// Upside down, a stray word read with confidence sits on a line the turned reading has words for.
const stray = [box("puny", 90, 300, 400, 380, 430)];
const lines = [box("committee", 95, 180, 360, 330, 395), box("budget", 95, 340, 360, 420, 395)];
check("a stray sure word on a page read well upside down doesn't stop the turn", !leavesBehind(stray, lines, 180, 600, 800));

// Tesseract can't start here: a stand-in reads page 2 as noise until it is turned.
const require = createRequire(import.meta.url);
const tesseract = require("tesseract.js");
const NOISE = ["GN", "ANI", "ST", "nn", "WOT", "aaissa", "Wwesl"].map((text, i) => ({ text, confidence: 20, bbox: { x0: 20 + i * 60, y0: 300, x1: 70 + i * 60, y1: 330 } }));
const GOOD = ["Invoice", "number", "INV-2026-0412", "Total", "due", "24,900.95"].map((text, i) => ({ text, confidence: 95, bbox: { x0: 40 + i * 80, y0: 40, x1: 110 + i * 80, y1: 70 } }));
const line = (words: typeof GOOD) => ({ bbox: { x0: words[0].bbox.x0, y0: words[0].bbox.y0, x1: words[words.length - 1].bbox.x1, y1: words[0].bbox.y1 }, words });
// Read 1: page 1 (well), read 2: page 2 as it lies (noise), read 3: page 2 upside down (well).
let read = 0;
tesseract.createWorker = async () => ({
  recognize: async () => {
    read++;
    const words = read === 2 ? NOISE : GOOD;
    return { data: { blocks: [{ paragraphs: [{ lines: [line(words)] }] }] } };
  },
  terminate: async () => {},
});

let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
  (globalThis as Record<string, unknown>).document = {
    createElement: () => {
      const c = canvasMod!.createCanvas(1, 1);
      return Object.assign(c, { style: {}, toBlob: (done: (b: Blob) => void) => done(new Blob([c.toBuffer("image/png")])) });
    },
  };
} catch {
  console.log("SKIP  checks that read pages (node-canvas not installed)");
}

if (canvasMod) {
  const { ocrTool } = await import("../lib/pdf/toolkit.ts");
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) doc.addPage([400, 300]).drawRectangle({ x: 20, y: 20, width: 360, height: 260, color: rgb(0.85, 0.85, 0.85) });
  const file = new File([(await doc.save()).slice() as unknown as BlobPart], "scan.pdf", { type: "application/pdf" });

  read = 0;
  const out = await ocrTool([file], { lang: "eng", output: "pdf" });
  check("page 2 is named as turned", out.note === "Page 2 was upside down: turned the right way up.", out.note);
  check("a page that read well is read once, the other until it reads well", read === 3, read);
  const result = await PDFDocument.load(await out.blob.arrayBuffer());
  check("page 2 is turned in the file, page 1 isn't", result.getPage(0).getRotation().angle === 0 && result.getPage(1).getRotation().angle === 180,
    result.getPages().map((p) => p.getRotation().angle));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const shown = await pdfjs.getDocument({ data: new Uint8Array(await out.blob.arrayBuffer()) }).promise;
  const page2 = await shown.getPage(2);
  const vp = page2.getViewport({ scale: 1 });
  const items = (await page2.getTextContent()).items as { str: string; transform: number[] }[];
  const inv = items.find((it) => it.str.includes("Invoice"));
  // Read upright at the top left of the page as shown (the render is 2 px per point).
  const at = inv ? vp.convertToViewportPoint(inv.transform[4], inv.transform[5]) : null;
  check("the words read the right way up where the page shows them", !!at && Math.abs(at[0] - 20) < 2 && at[1] > 20 && at[1] < 45, at);
  check("the noise isn't laid over the page", !items.some((it) => /WOT|aaissa/.test(it.str)));

  // To text: the same pages read the right way up, and the result says so.
  read = 0;
  const text = await ocrTool([file], { lang: "eng", output: "text" });
  const body = await text.blob.text();
  check("to text: the turned page's words", (body.match(/Invoice number/g) ?? []).length === 2 && !body.includes("WOT"), body);
  check("to text: the turned page is named", text.note === "Page 2 was upside down: read turned the right way up.", text.note);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll turned-page checks passed");
