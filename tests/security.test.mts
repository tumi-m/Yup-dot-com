process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { protectPdf, unlockPdf, isEncrypted } from "../lib/pdf/security.ts";

const base = await PDFDocument.create();
const page = base.addPage([400, 300]);
page.drawText("Top secret wizard notes", {
  x: 40, y: 200, size: 18, font: await base.embedFont(StandardFonts.Helvetica),
});
const plain = await base.save();

const locked = await protectPdf(plain, { userPassword: "open-sesame", allowPrinting: true, allowCopying: false });
console.log("encrypted flag:", await isEncrypted(locked));

// An independent reader (pdf.js) must refuse to open it without the password.
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc = "./pdf.worker.mjs";
let refusedWithoutPassword = false;
try {
  await pdfjs.getDocument({ data: locked.slice() }).promise;
} catch (e) {
  refusedWithoutPassword = (e as { name?: string }).name === "PasswordException";
}
const withPw = await pdfjs.getDocument({ data: locked.slice(), password: "open-sesame" }).promise;
const text = (await (await withPw.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
console.log("pdf.js refuses without password:", refusedWithoutPassword);
console.log("pdf.js reads with password:", JSON.stringify(text));

let wrongRejected = false;
try { await unlockPdf(locked, "wrong"); } catch { wrongRejected = true; }
console.log("wrong password rejected:", wrongRejected);

const unlocked = await unlockPdf(locked, "open-sesame");
console.log("unlocked still encrypted:", await isEncrypted(unlocked));
const reopened = await pdfjs.getDocument({ data: unlocked.slice() }).promise;
const text2 = (await (await reopened.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
console.log("unlocked opens freely:", JSON.stringify(text2));

const ok = refusedWithoutPassword && text.includes("wizard") && wrongRejected &&
  !(await isEncrypted(unlocked)) && text2.includes("wizard");
console.log(ok ? "\nPASS: protect/unlock round-trip verified by an independent reader" : "\nFAIL");
process.exit(ok ? 0 : 1);
