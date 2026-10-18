// Uploading to the cloud library (dashboard): a PDF that an owner password
// only restricts opens without a password, but was refused with pdf-lib's
// "Input document to `PDFDocument.load` is encrypted…", and a damaged file
// showed "Failed to parse PDF document (line:…)". Only a PDF that needs a
// password to open is refused now, in plain words.
import { PDFDocument } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import { pageCountToStore } from "../lib/pdf/operations.ts";
import { protectPdf } from "../lib/pdf/security.ts";
import { ENCRYPTED_MESSAGE, UNREADABLE_MESSAGE } from "../lib/pdf/errors.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const message = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

const plain = await PDFDocument.create();
for (let i = 0; i < 3; i++) plain.addPage([300, 200]);
const plainBytes = await plain.save();
check("a plain PDF is counted", (await pageCountToStore(plainBytes)) === 3);

// No print, no copy: opens without a password.
const restricted = await SecurePDFDocument.create();
for (let i = 0; i < 4; i++) restricted.addPage([300, 200]);
restricted.encrypt({ userPassword: "", ownerPassword: "boss", permissions: { printing: false, copying: false, modifying: false } });
const restrictedBytes = await restricted.save({ useObjectStreams: false });
check("an owner-password-only PDF is counted", (await pageCountToStore(restrictedBytes)) === 4);

const locked = await protectPdf(plainBytes, { userPassword: "open-sesame" });
const lockedMessage = await message(pageCountToStore(locked));
check("a PDF that needs a password says so plainly", lockedMessage === ENCRYPTED_MESSAGE, lockedMessage);

const damaged = new TextEncoder().encode("%PDF-1.7\nnot really a pdf at all\n%%EOF");
const damagedMessage = await message(pageCountToStore(damaged));
check("a damaged file says so plainly", damagedMessage === UNREADABLE_MESSAGE, damagedMessage);
const notPdf = await message(pageCountToStore(new TextEncoder().encode("hello")));
check("a file without a PDF header says so plainly", notPdf === UNREADABLE_MESSAGE, notPdf);
for (const m of [lockedMessage, damagedMessage, notPdf]) {
  check(`no library wording reaches people: ${JSON.stringify(m)}`, !/PDFDocument|ignoreEncryption|line:|offset=/.test(m ?? ""));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll library upload checks passed.");
