// A PDF restricted by an owner password only (no printing, no copying)
// opens without a password in every reader. Merge, Split, Rotate, Page
// numbers, Watermark, Protect and Edit/Sign PDF used to refuse it as
// "password-protected", Edit PDF only once the work was done. A file that
// needs a password to open still asks to be unlocked first.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFDocument as SecurePDFDocument } from "@cantoo/pdf-lib";
import * as kit from "../lib/pdf/toolkit.ts";
import { bakeAnnotations, insertBlankPage, rotatePagesBy } from "../lib/pdf/bake.ts";
import { detectFormFields, fillFormFields } from "../lib/pdf/forms.ts";
import { deletePages, getPageCount, mergePdfs } from "../lib/pdf/operations.ts";
import { unlockPdf } from "../lib/pdf/security.ts";
import { ENCRYPTED_MESSAGE, friendlyPdfError } from "../lib/pdf/errors.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
async function attempt(work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (err) {
    return friendlyPdfError(err).message;
  }
}
const ok = (result: unknown) => typeof result !== "string";
const file = (bytes: Uint8Array, name = "restricted.pdf") => new File([bytes.slice() as unknown as BlobPart], name, { type: "application/pdf" });
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

const plain = await (async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) d.addPage([400, 400]).drawText(`Page ${i}`, { x: 40, y: 340, size: 18, font });
  d.getForm().createTextField("name").addToPage(d.getPage(0), { x: 40, y: 280, width: 200, height: 20 });
  return d.save();
})();
async function lock(userPassword: string) {
  const d = await SecurePDFDocument.load(plain);
  d.encrypt({ userPassword, ownerPassword: "owner", permissions: { printing: false, copying: false, modifying: false } });
  return d.save({ useObjectStreams: true });
}
const restricted = await lock("");
const locked = await lock("pw");

const opened = await pdfjs.getDocument({ data: restricted.slice(), verbosity: 0 }).promise;
check("readers open it without a password", opened.numPages === 2);
await opened.destroy();

const runs: [string, () => Promise<unknown>][] = [
  ["merge", () => kit.mergeTool([file(restricted), file(restricted)])],
  ["split", () => kit.splitTool([file(restricted)], { mode: "every", ranges: "" })],
  ["rotate", () => kit.rotateTool([file(restricted)], { angle: "90" })],
  ["page numbers", () => kit.pageNumbersTool([file(restricted)], { position: "bottom-center", format: "n", fontSize: "12" })],
  ["watermark", () => kit.watermarkTool([file(restricted)], { text: "DRAFT", opacity: "0.3", color: "#ff0000", fontSize: "60" })],
  ["protect", () => kit.protectTool([file(restricted)], { password: "abcd", confirm: "abcd", printing: "yes", copying: "no" })],
  ["edit: save", () => bakeAnnotations(restricted, [{ id: "a", type: "text", page: 0, x: 40, y: 40, width: 200, height: 20, text: "Signed", fontSize: 14, color: "#000000", bold: false } as Annotation])],
  ["edit: fill form", () => fillFormFields(restricted, { name: "Thandiwe" })],
  ["edit: rotate page", () => rotatePagesBy(restricted, [0], 90)],
  ["edit: insert page", () => insertBlankPage(restricted, 0)],
  ["edit: delete page", () => deletePages(restricted, [1])],
  ["edit: merge", () => mergePdfs([restricted, plain])],
];
for (const [name, run] of runs) {
  const result = await attempt(run);
  check(`${name} works`, ok(result), result);
}
check("the editor counts its pages", (await attempt(() => getPageCount(restricted))) === 2);
check("the editor finds its fields", ((await detectFormFields(restricted)) as { name: string }[]).map((f) => f.name).join() === "name");

const filled = await fillFormFields(restricted, { name: "Thandiwe" });
check("filled value is kept", (await PDFDocument.load(filled)).getForm().getTextField("name").getText() === "Thandiwe");
const protectedOut = (await kit.protectTool([file(restricted)], { password: "abcd", confirm: "abcd", printing: "yes", copying: "no" })) as kit.ToolFile;
const protectedBytes = new Uint8Array(await protectedOut.blob.arrayBuffer());
const reopened = await attempt(() => unlockPdf(protectedBytes, "abcd"));
check("protect: the new password opens it", ok(reopened), reopened);

// A file that needs a password to open is still refused, plainly.
for (const [name, run] of [
  ["merge", () => kit.mergeTool([file(plain, "a.pdf"), file(locked, "locked.pdf")])],
  ["split", () => kit.splitTool([file(locked)], { mode: "every", ranges: "" })],
  ["edit: save", () => bakeAnnotations(locked, [])],
  ["protect", () => kit.protectTool([file(locked)], { password: "abcd", confirm: "abcd", printing: "yes", copying: "no" })],
] as [string, () => Promise<unknown>][]) {
  const result = await attempt(run);
  check(`${name}: an open password still asks to unlock first`, typeof result === "string" && result.endsWith(ENCRYPTED_MESSAGE), result);
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
