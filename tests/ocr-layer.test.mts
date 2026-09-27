process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./pdf.worker.mjs";
import { buildSearchablePdf } from "../lib/pdf/ocr-layer.ts";

const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

// A 1000x1400 px "scan" of a 500x700 pt page (2 px per point).
const out = await buildSearchablePdf([{
  widthPt: 500, heightPt: 700, image: PNG, imageType: "png", imageWidth: 1000, imageHeight: 1400,
  words: [
    { text: "Invoice", x0: 100, y0: 100, x1: 300, y1: 150, confidence: 95 },
    { text: "Total:", x0: 100, y0: 600, x1: 220, y1: 640, confidence: 91 },
    { text: "$4,200", x0: 240, y0: 600, x1: 400, y1: 640, confidence: 88 },
    { text: "garbage", x0: 500, y0: 900, x1: 600, y1: 940, confidence: 5 },   // below threshold
    { text: "日本", x0: 500, y0: 1000, x1: 600, y1: 1040, confidence: 99 },  // unencodable
  ],
}]);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = "./pdf.worker.mjs";
const doc = await pdfjs.getDocument({ data: out.slice() }).promise;
const items = (await (await doc.getPage(1)).getTextContent()).items as { str: string; transform: number[] }[];
const words = items.map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5] })).filter((w) => w.s);
console.log("extracted:", JSON.stringify(words.map((w) => `${w.s}@(${w.x.toFixed(0)},${w.y.toFixed(0)})`)));

// pdf.js merges adjacent words on one line into a single run, as viewers do.
const find = (s: string) => words.find((w) => w.s.includes(s));
const inv = find("Invoice"), tot = find("Total:");
// Invoice: x0=100px -> 50pt; bottom 150px -> 625pt, baseline +20% of 25pt -> 630pt.
// Total:   x0=100px -> 50pt; bottom 640px -> 380pt, baseline +20% of 20pt -> 384pt.
const posOk = !!inv && Math.abs(inv.x - 50) < 1 && Math.abs(inv.y - 630) < 2 &&
  !!tot && Math.abs(tot.x - 50) < 1 && Math.abs(tot.y - 384) < 2;
const filtered = !find("garbage") && !words.some((w) => w.s.includes("日"));
const ok = posOk && filtered && !!find("$4,200");
console.log(ok ? "\nPASS: invisible text layer is extractable at the scanned word positions" : `\nFAIL pos=${posOk} filtered=${filtered}`);
process.exit(ok ? 0 : 1);
