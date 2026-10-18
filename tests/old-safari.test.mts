process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// Safari before 17.4 (iPhones that can't go past iOS 16) and Firefox before
// 121 have no Promise.withResolvers. pdf.js's modern build calls it on every
// file, so every pdf.js tool said "This file isn't a readable PDF." there.
// The app and its worker use the legacy build, which brings it along.
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { configureWorker } from "../lib/pdf/worker.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const outcome = async <T,>(run: () => Promise<T>) => {
  try {
    return { value: await run() };
  } catch (err) {
    return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
};

// As on Safari 16, before pdf.js loads.
delete (Promise as { withResolvers?: unknown }).withResolvers;

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([300, 200]).drawText("Opened on an old iPhone", { x: 20, y: 100, size: 14, font });
doc.addPage([300, 200]);
const pdf = await doc.save();

const { parseDocument } = await import("../lib/pdf/parse.ts");
const parsed = await outcome(() => parseDocument(pdf));
const text = parsed.value?.blocks.map((b) => ("text" in b ? b.text : "")).join(" ") ?? "";
check("PDF to Word/Text/Excel and Chat read the file", /Opened on an old iPhone/.test(text), parsed.error ?? text);

const { loadForRender } = await import("../lib/pdf/render.ts");
const loaded = await outcome(() => loadForRender(pdf));
check("Edit PDF, PDF to JPG and OCR open the file", loaded.value?.numPages === 2, loaded.error);
loaded.value?.destroy();

const { pdfToPptx } = await import("../lib/pptx/from-pdf.ts");
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==",
    "base64"
  )
);
const deck = await outcome(() => pdfToPptx(pdf, { rasterize: async () => png }));
check("PDF to PPTX opens the file", !!deck.value && deck.value[0] === 0x50 && deck.value[1] === 0x4b, deck.error);

// The worker runs on its own, so it must carry the polyfill too.
delete process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC;
const lib = { GlobalWorkerOptions: { workerSrc: "" }, version: "9.9.9" };
configureWorker(lib);
check(
  "the app asks for the legacy worker, on a path of its own",
  lib.GlobalWorkerOptions.workerSrc === "/vendor/pdfjs/9.9.9/legacy/pdf.worker.min.mjs",
  lib.GlobalWorkerOptions.workerSrc
);
const vendor = src("scripts/copy-vendor.mjs");
check(
  "copy-vendor serves the legacy worker there",
  /copy\(\s*join\(pkgDir\("pdfjs-dist"\), "legacy", "build", "pdf\.worker\.min\.mjs"\),\s*join\(out, "pdfjs", pdfjs, "legacy", "pdf\.worker\.min\.mjs"\)\s*\)/.test(vendor)
);
check(
  "the legacy worker brings Promise.withResolvers",
  /withResolvers:function/.test(src("node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs"))
);

// Nothing loads the modern build at run time.
const modern: string[] = [];
for (const file of ["lib/pdf/render.ts", "lib/pdf/parse.ts", "lib/pptx/from-pdf.ts", "lib/pdf/page-content.ts", "lib/pdf/ocr.ts"]) {
  const code = src(file);
  for (const m of code.matchAll(/(?:^import\s+(?!type\b)[^;]*?from\s+|import\()"(pdfjs-dist[^"]*)"/gms)) {
    if (m[1] !== "pdfjs-dist/legacy/build/pdf.mjs") modern.push(`${file}: ${m[1]}`);
  }
}
check("no module loads pdf.js's modern build", modern.length === 0, modern);

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
