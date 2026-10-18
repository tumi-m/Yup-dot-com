process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// iOS Safari leaves a canvas of more than 4096 x 4096 pixels blank. On a 3x
// iPhone, Edit PDF's page went blank from 200% zoom; OCR PDF drew pages at
// 432 DPI, past the limit, and then waited forever for Tesseract.
import { createRequire } from "node:module";
import { PDFDocument, rgb } from "pdf-lib";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const LIMIT = 4096 * 4096;

let canvasMod: typeof import("canvas");
try {
  canvasMod = await import("canvas");
} catch {
  console.log("SKIP  canvas limits (node-canvas not installed)");
  process.exit(0);
}

// An iPhone 15: three device pixels to a CSS pixel.
(globalThis as Record<string, unknown>).window = {
  devicePixelRatio: 3,
  requestAnimationFrame: (run: () => void) => setTimeout(run, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
};
/** What toBlob gives: a PNG, or null as for a canvas the browser couldn't draw. */
let blobs: "png" | "null" = "png";
(globalThis as Record<string, unknown>).document = {
  createElement: () => {
    const c = canvasMod.createCanvas(1, 1);
    return Object.assign(c, {
      style: {} as Record<string, string>,
      toBlob: (done: (b: Blob | null) => void) => done(blobs === "png" ? new Blob([c.toBuffer("image/png")]) : null),
    });
  },
};

// Tesseract can't start here: a stand-in that reads its input as tesseract.js
// does, and like it never settles when a canvas's toBlob gives null.
const never = new Promise<never>(() => {});
const require = createRequire(import.meta.url);
const tesseract = require("tesseract.js");
tesseract.createWorker = async () => ({
  recognize: async (image: Blob | HTMLCanvasElement) => {
    const blob = image instanceof Blob ? image : await new Promise<Blob | null>((r) => image.toBlob(r));
    if (!blob) return never;
    return { data: { blocks: [] } };
  },
  terminate: async () => {},
});

const doc = await PDFDocument.create();
doc.addPage([595.28, 841.89]).drawRectangle({ x: 50, y: 50, width: 400, height: 600, color: rgb(0.8, 0.8, 0.8) }); // A4
const a4 = await doc.save();

// --- Edit PDF, zoomed in ------------------------------------------------------
const { loadForRender } = await import("../lib/pdf/render.ts");
const loaded = await loadForRender(a4);
const page = document.createElement("canvas");
await loaded.renderPage(1, page, 1);
check(
  "100%: drawn at the screen's full sharpness",
  page.width === Math.floor(595.28 * 3) && page.height === Math.floor(841.89 * 3),
  [page.width, page.height]
);
for (const zoom of [2, 2.4, 3]) {
  await loaded.renderPage(1, page, zoom);
  const area = page.width * page.height;
  check(`${zoom * 100}%: the page canvas stays within iOS Safari's limit`, area <= LIMIT && area > LIMIT * 0.99, area);
  check(`${zoom * 100}%: still shown at the zoomed size`, page.style.width === `${595.28 * zoom}px`, page.style.width);
}
loaded.destroy();

// --- OCR PDF ------------------------------------------------------------------
const { ocrDocument } = await import("../lib/pdf/ocr.ts");
const [read] = await ocrDocument(a4);
check(
  "OCR draws pages at 144 DPI whatever the screen",
  read?.imageWidth === Math.floor(595.28 * 2) && read?.imageHeight === Math.floor(841.89 * 2),
  read && [read.imageWidth, read.imageHeight]
);

blobs = "null";
const started = Date.now();
const outcome = await Promise.race([
  ocrDocument(a4).then(
    () => "finished",
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  ),
  new Promise<string>((r) => setTimeout(() => r("still running"), 5000)),
]);
check(
  "a page the device couldn't draw is said, not waited on forever",
  outcome === "Page 1 is too large to read on this device." && Date.now() - started < 5000,
  outcome
);

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
