// A file with a PDF header but no document after it must get the plain
// "isn't a readable PDF" message, never a raw TypeError.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { friendlyPdfError, UNREADABLE_MESSAGE } from "../lib/pdf/errors.ts";
import { mergeTool, pageNumbersTool, rotateTool, splitTool, unlockTool, watermarkTool } from "../lib/pdf/toolkit.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (err) {
    return friendlyPdfError(err).message;
  }
}

const file = (bytes: Uint8Array | string, name: string) =>
  new File([typeof bytes === "string" ? bytes : (bytes.slice() as unknown as BlobPart)], name, { type: "application/pdf" });

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([595, 842]).drawText("Page 1", { x: 20, y: 20, size: 12, font });
const good = await doc.save();

const broken: [string, Uint8Array | string][] = [
  ["header then junk", "%PDF-1.4\ngarbage not a pdf\n"],
  ["header only", "%PDF-1.7\n"],
  ["cut after 20 bytes", good.slice(0, 20)],
];

for (const [label, bytes] of broken) {
  const f = () => file(bytes, "bad.pdf");
  const rotate = await errorOf(rotateTool([f()], { angle: "90" }));
  check(`rotate, ${label}: readable message`, rotate === UNREADABLE_MESSAGE, rotate);
  const split = await errorOf(splitTool([f()], { mode: "every", ranges: "" }));
  check(`split, ${label}: readable message`, split === UNREADABLE_MESSAGE, split);
  const numbers = await errorOf(pageNumbersTool([f()], { position: "bottom-center", format: "n", fontSize: "12" }));
  check(`page numbers, ${label}: readable message`, numbers === UNREADABLE_MESSAGE, numbers);
  const mark = await errorOf(watermarkTool([f()], { text: "DRAFT", opacity: "0.3", color: "#ff0000", fontSize: "60" }));
  check(`watermark, ${label}: readable message`, mark === UNREADABLE_MESSAGE, mark);
  const merged = await errorOf(mergeTool([file(good, "a.pdf"), f()]));
  check(`merge, ${label}: readable message`, merged.endsWith(UNREADABLE_MESSAGE) && !/Cannot read|undefined/.test(merged), merged);
  // The damaged one is named, wherever it is in the list.
  const middle = await errorOf(mergeTool([file(good, "a.pdf"), file(bytes, "Invoice-March.pdf"), file(good, "c.pdf")]));
  check(`merge, ${label} in the middle: names it`, middle === `Invoice-March.pdf: ${UNREADABLE_MESSAGE}`, middle);
  const head = await errorOf(mergeTool([file(bytes, "first.pdf"), file(good, "b.pdf")]));
  check(`merge, ${label} first: names it`, head === `first.pdf: ${UNREADABLE_MESSAGE}`, head);
  // The encryption check alone passes a damaged file as an unprotected one.
  for (const password of ["", "x"]) {
    const unlock = await errorOf(unlockTool([f()], { password }));
    check(`unlock, ${label}, password "${password}": readable message`, unlock === UNREADABLE_MESSAGE, unlock);
  }
}

const cut = await errorOf(unlockTool([file(good.slice(0, 400), "cut.pdf")], { password: "" }));
check("unlock, cut after 400 bytes: readable message", cut === UNREADABLE_MESSAGE, cut);
const plain = await errorOf(unlockTool([file(good, "plain.pdf")], { password: "" }));
check("unlock, a plain PDF: nothing to unlock", /isn't password-protected/.test(plain), plain);

// Merge reports each file as it opens it, so a long merge shows where it is.
const steps: string[] = [];
await mergeTool([file(good, "a.pdf"), file(good, "b.pdf"), file(good, "c.pdf")], { progress: (_f, label) => steps.push(label) });
check("merge: progress by file", steps.join("|") === "File 1 of 3|File 2 of 3|File 3 of 3", steps);

check(
  "a TypeError from the library maps",
  friendlyPdfError(new TypeError("Cannot read properties of undefined (reading 'Pages')")).message === UNREADABLE_MESSAGE
);
check("a TypeError names the file", friendlyPdfError(new TypeError("x is undefined"), "a.pdf").message === `a.pdf: ${UNREADABLE_MESSAGE}`);
check("our own messages still pass through", friendlyPdfError(new Error("Pick pages between 1 and 5.")).message === "Pick pages between 1 and 5.");

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
