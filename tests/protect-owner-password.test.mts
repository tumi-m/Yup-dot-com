// Protect PDF must not reuse the open password as the owner password.
// If it does, anyone who can open the file is the owner, and readers drop
// the "no printing" / "no copying" restrictions.
import { createCipheriv, createHash } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  PDFDict,
  PDFDocument as SecurePDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from "@cantoo/pdf-lib";
import { protectPdf } from "../lib/pdf/security.ts";

let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) failed++;
}

// ISO 32000-2 Algorithm 2.B (the AES-256 / R6 password hash).
function hash2B(password: Buffer, salt: Buffer, userKey: Buffer): Buffer {
  let k = createHash("sha256").update(Buffer.concat([password, salt, userKey])).digest();
  let e = Buffer.alloc(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const block = Buffer.concat([password, k, userKey]);
    const cipher = createCipheriv("aes-128-cbc", k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    e = Buffer.concat([cipher.update(Buffer.concat(Array(64).fill(block))), cipher.final()]);
    const algo = ["sha256", "sha384", "sha512"][e.subarray(0, 16).reduce((a, b) => a + b, 0) % 3];
    k = createHash(algo).update(e).digest();
  }
  return k.subarray(0, 32);
}

async function securityEntries(bytes: Uint8Array) {
  const doc = await SecurePDFDocument.load(bytes, { ignoreEncryption: true });
  const dict = doc.context.lookup(doc.context.trailerInfo.Encrypt, PDFDict);
  const bytesOf = (key: string) =>
    Buffer.from((dict.get(PDFName.of(key)) as PDFString | PDFHexString).asBytes());
  return { O: bytesOf("O"), U: bytesOf("U"), R: String(dict.get(PDFName.of("R"))) };
}

const isUser = (pw: string, { U }: { U: Buffer }) =>
  hash2B(Buffer.from(pw), U.subarray(32, 40), Buffer.alloc(0)).equals(U.subarray(0, 32));
const isOwner = (pw: string, { O, U }: { O: Buffer; U: Buffer }) =>
  hash2B(Buffer.from(pw), O.subarray(32, 40), U.subarray(0, 48)).equals(O.subarray(0, 32));

const base = await PDFDocument.create();
base.addPage([300, 200]).drawText("secret", {
  x: 40, y: 100, size: 18, font: await base.embedFont(StandardFonts.Helvetica),
});
const plain = await base.save();

// What the Protect tool sends: an open password and restrictions, no owner password.
const locked = await protectPdf(plain, {
  userPassword: "open-sesame",
  allowPrinting: false,
  allowCopying: false,
});
const entries = await securityEntries(locked);
check("uses AES-256 (R6)", entries.R === "6");
check("open password opens the file", isUser("open-sesame", entries));
check("open password is not the owner password", !isOwner("open-sesame", entries));

// A given owner password is still honoured.
const withOwner = await securityEntries(
  await protectPdf(plain, { userPassword: "open-sesame", ownerPassword: "boss" })
);
check("given owner password is used", isOwner("boss", withOwner));
check("open password is not the given owner password", !isOwner("open-sesame", withOwner));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll owner password checks passed.");
