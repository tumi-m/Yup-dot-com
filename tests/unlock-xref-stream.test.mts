// Unlocking a PDF that keeps its objects in object streams with an xref
// stream (the usual layout from Acrobat and Word) must give a plain PDF.
// The old security dictionary and xref stream used to be written back out,
// so the result still read as encrypted.
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { protectPdf, unlockPdf, isEncrypted } from "../lib/pdf/security.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
for (let i = 1; i <= 3; i++) {
  src.addPage([300, 200]).drawText(`Page ${i}`, { x: 40, y: 100, size: 18, font });
}
src.encrypt({ userPassword: "pw", ownerPassword: "owner" });
const locked = await src.save({ useObjectStreams: true });
const lockedText = Buffer.from(locked).toString("latin1");
check("fixture uses an xref stream", /\/Type\s*\/XRef/.test(lockedText));
check("fixture uses object streams", /\/Type\s*\/ObjStm/.test(lockedText));
check("fixture is encrypted", await isEncrypted(locked));

const unlocked = await unlockPdf(locked, "pw");
check("unlocked copy is not encrypted", !(await isEncrypted(unlocked)));
check(
  "unlocked copy has no /Encrypt or /Standard handler",
  !/\/Encrypt|\/Filter\s*\/Standard/.test(Buffer.from(unlocked).toString("latin1"))
);

const reopened = await PDFDocument.load(unlocked, { ignoreEncryption: true });
check("unlocked copy keeps all pages", reopened.getPageCount() === 3, String(reopened.getPageCount()));

let protectedAgain = false;
try {
  protectedAgain = (await protectPdf(unlocked, { userPassword: "new" })).length > 0;
} catch (e) {
  console.log((e as Error).message);
}
check("unlocked copy can be protected again", protectedAgain);

let reUnlocked = false;
try {
  reUnlocked = !(await isEncrypted(await unlockPdf(unlocked, "")));
} catch (e) {
  console.log((e as Error).message);
}
check("unlocking the copy again does not ask for a password", reUnlocked);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll unlock xref-stream checks passed.");
