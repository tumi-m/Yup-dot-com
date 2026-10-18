// Unlock PDF keeps the title, author and file identifier. Decrypting a file
// written with a cross-reference stream (Acrobat, Word, qpdf) used to lose
// the trailer's Info and ID, so the unlocked copy had no title. OCR and the
// other tools open owner-password files through the same unlock.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument as SecurePDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { isEncrypted, protectPdf, unlockPdf } from "../lib/pdf/security.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
async function meta(bytes: Uint8Array, password?: string) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), password, verbosity: 0 }).promise;
  const info = (await doc.getMetadata()).info as { Title?: string; Author?: string };
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
  await doc.destroy();
  return { title: info.Title, author: info.Author, text };
}

async function source() {
  const d = await SecurePDFDocument.create();
  d.addPage([612, 792]).drawText("Quarterly figures", { x: 72, y: 700, size: 20, font: await d.embedFont(StandardFonts.Helvetica) });
  d.setTitle("Quarterly Report");
  d.setAuthor("Nomvula Dlamini");
  return d;
}

// Object streams and an xref stream, as Acrobat and Word write them; and a
// classic xref table (from Protect PDF, which encrypts the strings too).
const cases: [string, string, Uint8Array][] = [];
for (const userPassword of ["pw", ""]) {
  const d = await source();
  d.encrypt({ userPassword, ownerPassword: "owner" });
  cases.push([`xref stream, ${userPassword ? "open password" : "owner password only"}`, userPassword, await d.save({ useObjectStreams: true })]);
}
cases.push(["xref table, open password", "pw", await protectPdf(await (await source()).save({ useObjectStreams: false }), { userPassword: "pw" })]);

for (const [label, password, locked] of cases) {
  const before = await meta(locked, password);
  check(`${label}: the locked file has its title`, before.title === "Quarterly Report", before);

  const out = await unlockPdf(locked, password);
  const after = await meta(out);
  check(`${label}: unlocked`, !(await isEncrypted(out)));
  check(`${label}: title and author kept`, after.title === "Quarterly Report" && after.author === "Nomvula Dlamini", after);
  check(`${label}: text kept`, after.text === "Quarterly figures", after.text);
  check(`${label}: file identifier kept`, /\/ID\s*\[/.test(new TextDecoder("latin1").decode(out)));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
