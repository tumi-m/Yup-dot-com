// A PDF restricted with an owner password only opens without a password, so
// Compress PDF compresses it. Decrypting one saved with a cross-reference
// stream (as Acrobat writes PDF 1.5+) used to lose the trailer's Info and ID:
// the title and author were gone from the compressed copy.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { PDFDocument as SecurePDFDocument, StandardFonts } from "@cantoo/pdf-lib";

const codec = await import("../lib/image-codec");
const { compressPdf } = await import("../lib/pdf/compress/index");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});

let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failed++;
}

async function meta(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const info = (await doc.getMetadata()).info as { Title?: string; Author?: string };
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
  await doc.destroy();
  return { title: info.Title, author: info.Author, text };
}

{
  const d = await SecurePDFDocument.create();
  d.addPage([612, 792]).drawText("Restricted", { x: 72, y: 700, size: 20, font: await d.embedFont(StandardFonts.Helvetica) });
  d.setTitle("Quarterly Report");
  d.setAuthor("Ann Example");
  d.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { printing: false, copying: false } });
  const restricted = await d.save({ useObjectStreams: true });

  const before = await meta(restricted);
  check("the input reads as expected", before.title === "Quarterly Report" && before.author === "Ann Example", before);

  const out = await compressPdf(restricted, { preset: "balanced" });
  const after = await meta(out);
  check("title and author kept", after.title === "Quarterly Report" && after.author === "Ann Example", after);
  check("text kept", after.text.includes("Restricted"), after.text);
  check("file identifier kept", /\/ID\s*\[/.test(new TextDecoder("latin1").decode(out)));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
