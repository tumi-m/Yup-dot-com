process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// OCR PDF stops as soon as the person cancels, picks another file or leaves;
// says plainly when the OCR engine can't load; and keeps a PDF restricted by
// an owner password only (it opens without one) as it is. PDF to PPTX stops too.
import { createRequire } from "node:module";
import { crc32, deflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import { friendlyPdfError } from "../lib/pdf/errors.ts";
import { pdfToPptx, pdfToPptxTool } from "../lib/pptx/from-pdf.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Tesseract's worker can't start here: a stand-in engine, set per case.
interface Word {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
interface Engine {
  /** What createWorker resolves to, or how it fails. */
  ready: (options: { errorHandler?: (err: unknown) => void }) => Promise<unknown>;
  words?: Word[];
  /** recognize never settles, like a page still being read. */
  slow?: boolean;
}
let engine: Engine;
let recognized = 0;
let terminated = 0;
const require = createRequire(import.meta.url);
const tesseract = require("tesseract.js");
tesseract.createWorker = (_lang: string, _oem: number, options: { errorHandler?: (err: unknown) => void }) => engine.ready(options);
const worker = () => ({
  recognize: () => {
    recognized++;
    if (engine.slow) return new Promise(() => {});
    const words = (engine.words ?? []).map((w) => ({ ...w, confidence: 95 }));
    return Promise.resolve({ data: { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } });
  },
  terminate: async () => {
    terminated++;
  },
});
const loads = (): Engine["ready"] => async () => worker();
const never = new Promise<never>(() => {});

let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
  // Pages are rendered into a canvas before they are read.
  (globalThis as Record<string, unknown>).document = { createElement: () => Object.assign(canvasMod!.createCanvas(1, 1), { style: {} }) };
} catch {
  console.log("SKIP  checks that render pages (node-canvas not installed)");
}

const { ocrDocument } = await import("../lib/pdf/ocr.ts");
const { ocrTool, openForTextLayer } = await import("../lib/pdf/toolkit.ts");

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
/** The outcome, or "still running" if it hasn't settled within `ms`. */
async function settle(run: Promise<unknown>, ms = 3000) {
  const started = Date.now();
  const result = await Promise.race([
    run.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    ),
    new Promise<{ running: true }>((r) => setTimeout(() => r({ running: true }), ms)),
  ]);
  return { ...result, ms: Date.now() - started } as { value?: unknown; error?: unknown; running?: true; ms: number };
}
const pdfFile = (bytes: Uint8Array, name = "scan.pdf") => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });

/** A grey PNG, hand-made: no canvas needed. */
function greyPng(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // grey
  const raw = Buffer.alloc((w + 1) * h, 200);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
  );
}

/**
 * Pages with no text of its own, so each is read. Drawn, not pictures: pdf.js
 * can't paint images under Node without node-canvas wired into it.
 */
async function scan(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 200]).drawRectangle({ x: 20, y: 20, width: 260, height: 160, color: rgb(0.8, 0.8, 0.8) });
  return doc.save();
}

/** Restricted by an owner password only: no password needed to open it. */
async function ownerOnly(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await SecurePDFDocument.load(bytes);
  doc.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false, copying: false, modifying: false } });
  return doc.save({ useObjectStreams: false });
}

// --- The engine can't load ---------------------------------------------------
const ENGINE_FAILED = "Couldn't load the OCR engine. Check your connection and try again.";
const oneScan = await scan(1);
// Tesseract rejects with a bare message, not an Error.
engine = { ready: () => Promise.reject("Error: NetworkError when attempting to fetch resource.") };
let r = await settle(ocrDocument(oneScan));
check("engine didn't download: a plain message", r.error instanceof Error && friendlyPdfError(r.error).message === ENGINE_FAILED, r);
// A language file that fails to download is only reported to errorHandler.
engine = {
  ready: (options) => {
    setTimeout(() => options.errorHandler?.("Error: Network error while fetching /vendor/tessdata/eng.traineddata.gz"), 50);
    return never;
  },
};
r = await settle(ocrDocument(oneScan));
check("language file didn't download: a plain message, not an endless wait", r.error instanceof Error && friendlyPdfError(r.error).message === ENGINE_FAILED, r);

// --- Stopping ----------------------------------------------------------------
let ctl = new AbortController();
ctl.abort();
r = await settle(ocrDocument(oneScan, { signal: ctl.signal }));
check("an aborted run doesn't start", isAbort(r.error), r);

// Stopped while the engine is still loading; it is shut down once it has loaded.
let engineLoaded = (_w: unknown) => {};
engine = { ready: () => new Promise((resolve) => (engineLoaded = resolve)) };
terminated = 0;
ctl = new AbortController();
const loading = ocrDocument(oneScan, { signal: ctl.signal, onProgress: (p) => p.stage === "loading" && setTimeout(() => ctl.abort(), 20) });
r = await settle(loading);
check("stopped while the engine loads: the run ends at once", isAbort(r.error) && r.ms < 1000, r);
engineLoaded(worker());
await new Promise((resolve) => setTimeout(resolve, 20));
check("stopped while the engine loads: the engine is shut down when it arrives", terminated === 1, terminated);

// OCR PDF hands the tool's signal on (leaving the page or a new file aborts it).
engine = { ready: () => never };
ctl = new AbortController();
const tool = ocrTool([pdfFile(oneScan)], { lang: "eng", output: "pdf" }, { signal: ctl.signal, progress: () => ctl.abort() });
r = await settle(tool);
check("OCR PDF stops when the tool's job is aborted", isAbort(r.error), r);
ctl = new AbortController();
const toText = ocrTool([pdfFile(oneScan)], { lang: "eng", output: "text" }, { signal: ctl.signal, progress: () => ctl.abort() });
r = await settle(toText);
check("OCR to text stops when the tool's job is aborted", isAbort(r.error), r);

if (canvasMod) {
  // Stopped while a page is being read: the engine is shut down, nothing waits on it.
  engine = { ready: loads(), slow: true };
  recognized = terminated = 0;
  ctl = new AbortController();
  const reading = ocrDocument(oneScan, { signal: ctl.signal, onProgress: (p) => p.stage === "rendering" && setTimeout(() => ctl.abort(), 100) });
  r = await settle(reading);
  check("stopped mid-page: the run ends at once", isAbort(r.error) && recognized === 1, { ...r, recognized });
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("stopped mid-page: the engine is shut down", terminated === 1, terminated);

  // Stopped after page 1 of 3: pages 2 and 3 aren't read.
  engine = { ready: loads(), words: [{ text: "Invoice", bbox: { x0: 40, y0: 40, x1: 200, y1: 80 } }] };
  recognized = 0;
  ctl = new AbortController();
  r = await settle(ocrDocument(await scan(3), { signal: ctl.signal, onProgress: (p) => p.stage === "rendering" && p.page === 2 && ctl.abort() }));
  check("stopped between pages: no more pages are read", isAbort(r.error) && recognized === 1, { ...r, recognized });

  // --- Owner password only ---------------------------------------------------
  // A scan restricted by an owner password keeps its pages; only the words are added.
  engine = { ready: loads(), words: [{ text: "Invoice", bbox: { x0: 40, y0: 40, x1: 200, y1: 80 } }] };
  const restrictedScan = await ownerOnly(await scan(1));
  r = await settle(ocrTool([pdfFile(restrictedScan)], { lang: "eng", output: "pdf" }), 20000);
  const out = r.value ? new Uint8Array(await (r.value as { blob: Blob }).blob.arrayBuffer()) : null;
  if (!out) check("owner-only scan: made searchable", false, r);
  else {
    const doc = await PDFDocument.load(out);
    const images = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => o)
      .filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")) as PDFRawStream[];
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const d = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
    const text = ((await (await d.getPage(1)).getTextContent()).items as { str: string }[]).map((i) => i.str).join(" ");
    await d.destroy();
    check("owner-only scan: the original page is kept, not replaced by a picture of it", images.length === 0, images.length);
    check("owner-only scan: the words are added", text.includes("Invoice"), text);
    check("owner-only scan: about the size it came", out.length < restrictedScan.length + 4000, { in: restrictedScan.length, out: out.length });
  }

  // A digital PDF restricted the same way already has its text.
  const digital = await PDFDocument.create();
  const helv = await digital.embedFont(StandardFonts.Helvetica);
  digital.addPage([400, 200]).drawText("Top secret wizard notes for the spring term", { x: 20, y: 100, size: 14, font: helv });
  engine = {
    ready: loads(),
    words: "Top secret wizard notes for the spring term".split(" ").map((text, i) => ({ text, bbox: { x0: 40 + i * 60, y0: 180, x1: 90 + i * 60, y1: 210 } })),
  };
  // pdf.js warns that it can't fetch the standard fonts here; the page still renders.
  const log = console.log;
  console.log = (...args: unknown[]) => void (String(args[0]).startsWith("Warning:") || log(...args));
  r = await settle(ocrTool([pdfFile(await ownerOnly(await digital.save()))], { lang: "eng", output: "pdf" }), 20000);
  console.log = log;
  check(
    "owner-only digital PDF: said to be searchable already, not flattened",
    r.error instanceof Error && r.error.message.startsWith("This PDF can already be searched and copied."),
    r.error instanceof Error ? r.error.message : r
  );
}

// --- Opening for the text layer ----------------------------------------------
const plainDoc = await scan(1);
check("openForTextLayer: a plain PDF opens", (await openForTextLayer(plainDoc))?.getPageCount() === 1);
const opened = await openForTextLayer(await ownerOnly(plainDoc));
check("openForTextLayer: an owner-password-only PDF opens, decrypted", opened?.getPageCount() === 1 && !opened.context.trailerInfo.Encrypt);
const locked = await SecurePDFDocument.load(plainDoc);
locked.encrypt({ userPassword: "open sesame", ownerPassword: "owner" });
check("openForTextLayer: a PDF that needs a password doesn't", (await openForTextLayer(await locked.save({ useObjectStreams: false }))) === null);
check("openForTextLayer: neither does a file that isn't a PDF", (await openForTextLayer(new TextEncoder().encode("not a PDF at all"))) === null);

// --- PDF to PPTX -------------------------------------------------------------
let rasterized = 0;
ctl = new AbortController();
const slides = pdfToPptx(await scan(3), {
  signal: ctl.signal,
  rasterize: async () => {
    rasterized++;
    ctl.abort();
    return greyPng(30, 20);
  },
});
r = await settle(slides);
check("PDF to PPTX stops between pages", isAbort(r.error) && rasterized === 1, { ...r, rasterized });
ctl = new AbortController();
ctl.abort();
r = await settle(pdfToPptxTool([pdfFile(await scan(1))], { quality: "standard" }, { signal: ctl.signal }));
check("PDF to PPTX hands the tool's signal on", isAbort(r.error), r);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
