// Long PDF tools kept working after the person cancelled or left the page:
// Compress PDF's worker ran on (three runs left three workers going), and
// PDF to JPG, Images to PDF and the text tools never looked at the signal.
// Images to PDF also froze the page for seconds per photo: it now runs in a
// worker, which is stopped the same way.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from "pdf-lib";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});
const { workerJob } = await import("../lib/worker-job.ts");
const { compressFile } = await import("../lib/pdf/compress/off-thread.ts");
const { compressPdf } = await import("../lib/pdf/compress/index.ts");
const { imagesToPdfFile } = await import("../lib/pdf/images-to-pdf/off-thread.ts");
const { imagesToPdf } = await import("../lib/pdf/images-to-pdf/index.ts");
const { compressTool, pdfToTextTool, imagesToPdfTool } = await import("../lib/pdf/toolkit.ts");
const { parseDocument } = await import("../lib/pdf/parse.ts");

const outcome = (p: Promise<unknown>) => p.then(() => "finished", (err) => (err as Error).name || String(err));
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A stand-in for a Web Worker that answers only when told to. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { preventDefault(): void }) => void) | null = null;
  terminated = false;
  posted: unknown[] = [];
  constructor(public url: URL) {
    FakeWorker.all.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: unknown) {
    if (!this.terminated) this.onmessage?.({ data });
  }
  crash() {
    if (!this.terminated) this.onerror?.({ preventDefault() {} });
  }
}
const g = globalThis as Record<string, unknown>;

// A PDF with a few photo-like pictures, each worth recompressing.
async function photoPdf(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) {
    const w = 600;
    const h = 400;
    const px = new Uint8Array(w * h * 3);
    let seed = i + 1;
    for (let k = 0; k < px.length; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      px[k] = ((k / 3) % w) / 3 + (seed >>> 28);
    }
    const image = doc.context.register(
      PDFRawStream.of(doc.context.obj({ Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }), px)
    );
    const page = doc.addPage([300, 200]);
    page.node.setXObject(PDFName.of("Im0"), image);
    const content = doc.context.register(doc.context.stream("q 300 0 0 200 0 0 cm /Im0 Do Q"));
    page.node.set(PDFName.of("Contents"), content);
  }
  return doc.save();
}
const photos = await photoPdf(3);
const pdfFile = (bytes: Uint8Array, name = "scan.pdf") => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });

// --- The worker runner -------------------------------------------------------
{
  const w = new FakeWorker(new URL("file:///w.js"));
  const seen: string[] = [];
  const job = workerJob<{ type: "done"; n: number }>(w as unknown as Worker, { hi: 1 }, [], (_f, label) => seen.push(label));
  w.reply({ type: "progress", fraction: 0.5, label: "Half" });
  w.reply({ type: "done", n: 7 });
  const answer = await job;
  check("worker job: progress is passed on", seen.join() === "Half", seen);
  check("worker job: the answer comes back and the worker is stopped", answer?.n === 7 && w.terminated);

  const ctl = new AbortController();
  const w2 = new FakeWorker(new URL("file:///w.js"));
  const cancelled = outcome(workerJob(w2 as unknown as Worker, {}, [], undefined, ctl.signal));
  ctl.abort();
  check("worker job: cancel stops the worker at once", (await cancelled) === "AbortError" && w2.terminated, await cancelled);

  const w3 = new FakeWorker(new URL("file:///w.js"));
  const crashed = workerJob(w3 as unknown as Worker, {}, []);
  w3.crash();
  check("worker job: a worker that can't start answers null", (await crashed) === null && w3.terminated);
}

// --- Compress PDF --------------------------------------------------------------
g.window = globalThis;
g.Worker = FakeWorker;
{
  FakeWorker.all = [];
  const ctl = new AbortController();
  const labels: string[] = [];
  const run = outcome(compressTool([pdfFile(photos)], { quality: "balanced" }, { signal: ctl.signal, progress: (_f, l) => labels.push(l) }));
  while (!FakeWorker.all[0]?.posted.length) await tick();
  const w = FakeWorker.all[0];
  w.reply({ type: "progress", fraction: 0.3, label: "Image 1 of 3" });
  ctl.abort();
  w.reply({ type: "error", kind: "codec", message: "no codec" });
  check("compress: cancel ends with an AbortError", (await run) === "AbortError", await run);
  check("compress: the worker is stopped", w.terminated);
  check("compress: progress came through until then", labels.join() === "Image 1 of 3", labels);
  check("compress: nothing else starts (no second worker, no fallback)", FakeWorker.all.length === 1);

  // Three runs, each replaced by the next: none keeps going.
  FakeWorker.all = [];
  const runs: Promise<string>[] = [];
  let ctlN = new AbortController();
  for (let i = 0; i < 3; i++) {
    if (i) ctlN.abort();
    ctlN = new AbortController();
    runs.push(outcome(compressFile(pdfFile(photos), "balanced", undefined, ctlN.signal)));
    while (FakeWorker.all.length < i + 1 || !FakeWorker.all[i].posted.length) await tick();
  }
  ctlN.abort();
  const ended = await Promise.all(runs);
  check("compress: three runs, three workers stopped", FakeWorker.all.every((w) => w.terminated) && ended.every((e) => e === "AbortError"), ended);

  // The worker can't start: the same job on this thread.
  FakeWorker.all = [];
  const fallback = compressFile(pdfFile(photos), "balanced");
  while (!FakeWorker.all[0]?.posted.length) await tick();
  FakeWorker.all[0].crash();
  const out = await fallback;
  check("compress: a worker that can't start still compresses here", out.length > 0 && out.length < photos.length, { out: out.length, in: photos.length });
}

// --- Images to PDF ---------------------------------------------------------------
const jpeg = await codec.encodeJpeg(
  { data: new Uint8ClampedArray(64 * 48 * 4).map((_, k) => (k * 7) % 255), width: 64, height: 48 },
  { quality: 80 }
);
const photo = (name: string) => new File([jpeg.slice() as unknown as BlobPart], name, { type: "image/jpeg" });
{
  FakeWorker.all = [];
  const labels: string[] = [];
  const job = imagesToPdfTool([photo("a.jpg"), photo("b.jpg")], { pageSize: "fit", margin: "0" }, { progress: (_f, l) => labels.push(l) });
  while (!FakeWorker.all[0]?.posted.length) await tick();
  const w = FakeWorker.all[0];
  const sent = w.posted[0] as { files: File[]; opts: { pageSize: string } };
  check("images to PDF: the pictures go to a worker", sent.files.map((f) => f.name).join() === "a.jpg,b.jpg" && sent.opts.pageSize === "fit", sent);
  // The worker's answer, made as the worker makes it.
  const made = await imagesToPdf(sent.files, sent.opts as never, (fraction, label) => w.reply({ type: "progress", fraction, label }));
  w.reply({ type: "done", bytes: made });
  const out = await job;
  check("images to PDF: the worker's file comes back", (await PDFDocument.load(await out.blob.arrayBuffer())).getPageCount() === 2);
  check("images to PDF: with its progress", labels.join() === "Image 1 of 2,Image 2 of 2", labels);

  FakeWorker.all = [];
  const ctl = new AbortController();
  const run = outcome(imagesToPdfFile([photo("a.jpg")], { pageSize: "a4", margin: "0" }, undefined, ctl.signal));
  while (!FakeWorker.all[0]?.posted.length) await tick();
  ctl.abort();
  check("images to PDF: cancel stops the worker", (await run) === "AbortError" && FakeWorker.all[0].terminated, await run);

  FakeWorker.all = [];
  const bad = imagesToPdfFile([photo("a.jpg")], { pageSize: "a4", margin: "0" }).then(() => "", (err) => (err as Error).message);
  while (!FakeWorker.all[0]?.posted.length) await tick();
  FakeWorker.all[0].reply({ type: "error", message: "a.jpg: this image looks damaged." });
  check("images to PDF: the worker's message is shown as it is", (await bad) === "a.jpg: this image looks damaged.", await bad);
}
delete g.window;
delete g.Worker;

// --- On this thread: between pictures, between pages ------------------------------
{
  const ctl = new AbortController();
  let calls = 0;
  const run = outcome(
    imagesToPdf([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")], { pageSize: "fit", margin: "0" }, () => {
      if (++calls === 2) ctl.abort();
    }, ctl.signal)
  );
  check("images to PDF here: stops before the next picture", (await run) === "AbortError" && calls === 2, { run: await run, calls });

  const stop = new AbortController();
  let images = 0;
  const squeezed = outcome(
    compressPdf(photos, {
      preset: "balanced",
      signal: stop.signal,
      onProgress: (_f, label) => {
        if (label.startsWith("Image 2") && !images++) stop.abort();
      },
    })
  );
  check("compress here: stops between pictures", (await squeezed) === "AbortError", await squeezed);

  const text = await (async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 12; i++) doc.addPage([400, 400]).drawText(`Page ${i + 1} has some words on it`, { x: 40, y: 300, size: 14, font });
    return doc.save();
  })();
  const read = new AbortController();
  let pages = 0;
  const parsed = outcome(
    parseDocument(text, () => {
      if (++pages === 3) read.abort();
    }, read.signal)
  );
  check("text tools: reading stops between pages", (await parsed) === "AbortError" && pages === 3, { parsed: await parsed, pages });
  const gone = new AbortController();
  gone.abort();
  check("PDF to Text: a page left before it starts does nothing", (await outcome(pdfToTextTool([pdfFile(text, "t.pdf")], { signal: gone.signal }))) === "AbortError");
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
