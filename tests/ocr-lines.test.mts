process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// The OCR text layer puts the words of a line on the line's baseline at one
// size. Each word used its own box: "problem" (a descender) sat lower and "a"
// (no ascender) smaller than "Boil", so PDF to Word, PDF to Text and Chat
// with PDF read OCR'd notes with words moved to the next line. A bullet read
// as "©" or an unsure "eo" becomes "•", so the notes read as a list.
import { buildSearchablePdf, lineWords, type OcrLine } from "../lib/pdf/ocr-layer.ts";
import { parseDocument, toMarkdown } from "../lib/pdf/parse.ts";

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

/** A line as Tesseract gives it: words boxed tightly, a baseline at `base`. */
function line(top: number, base: number, words: [string, number, number, number?][], confidence = 95): OcrLine {
  // [text, x0, x1, descends?]: ascenders reach `top`, x-height letters top + 7, descenders base + 6.
  const boxes = words.map(([text, x0, x1, kind = 0]) => ({
    text,
    confidence: text === "eo" || text === "©" ? 40 : confidence,
    bbox: { x0, x1, y0: kind === 2 ? top + 7 : top, y1: kind === 1 ? base + 6 : base },
  }));
  return { bbox: { x0: words[0][1], x1: words[words.length - 1][2], y0: top, y1: base + 6 }, baseline: { x0: words[0][1], y0: base, x1: words[words.length - 1][2], y1: base, has_baseline: true }, words: boxes };
}

// Two bulleted lines and a wrapped line, 2 px per point.
const lines = [
  line(100, 124, [["eo", 60, 72, 2], ["Boil", 110, 160], ["a", 172, 184, 2], ["problem", 196, 290, 1], ["down", 302, 360], ["to", 372, 396], ["the", 408, 450], ["truths", 462, 540]]),
  line(140, 164, [["you're", 110, 190, 1], ["sure", 202, 258, 2], ["of,", 270, 300], ["then", 312, 370], ["reason", 382, 462, 2], ["up", 474, 504, 1]]),
  line(180, 204, [["©", 60, 72, 2], ["Analogy", 110, 220, 1], ["is", 232, 256], ["mentally", 268, 380, 1], ["easier.", 392, 480]]),
];
const words = lines.flatMap(lineWords);

check("a bullet read as a stray letter or sign becomes a bullet", words[0].text === "•" && words.filter((w) => w.text === "•").length === 2, JSON.stringify(words.map((w) => w.text)));
const first = words.filter((w) => w.y0 >= 100 && w.y1 <= 130);
check("the words of a line share its baseline and size", first.every((w) => w.baseline === 124 && w.size === first[0].size), JSON.stringify(first.map((w) => [w.text, w.baseline, w.size])));
// Capitals rise 24 px: about 0.72 of the size.
check("the size is the line's, not the smallest letter's", Math.abs((first[0].size ?? 0) - 24 / 0.72) < 0.5, String(first[0].size));
// A word that isn't a bullet keeps its letters.
check("a short word with a sure read stays a word", lineWords(line(100, 124, [["A", 60, 72], ["word", 110, 160]]))[0].text === "A");

const pdf = await buildSearchablePdf([{ widthPt: 300, heightPt: 150, image: PNG, imageType: "png", imageWidth: 600, imageHeight: 300, words }]);
const md = toMarkdown(await parseDocument(pdf));
check("each line reads in order", md.includes("Boil a problem down to the truths you're sure of, then reason up"), md);
check("the bullets make a list", /^- Boil a problem/m.test(md) && /^- Analogy is mentally easier\./m.test(md), md);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll OCR line checks passed");
