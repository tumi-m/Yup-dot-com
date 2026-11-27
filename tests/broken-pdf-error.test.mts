// A file with a PDF header but no document after it must get the plain
// "isn't a readable PDF" message, never a raw TypeError.
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ENCRYPTED_MESSAGE, friendlyFileError, friendlyPdfError, UNREADABLE_MESSAGE } from "../lib/pdf/errors.ts";
import { getPageCount } from "../lib/pdf/operations.ts";
import { protectPdf } from "../lib/pdf/security.ts";
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
check("a stack overflow from a page tree that loops maps", friendlyPdfError(new RangeError("Maximum call stack size exceeded")).message === UNREADABLE_MESSAGE);
check(
  "pdf.js's circular page tree maps",
  friendlyPdfError(Object.assign(new Error("Pages tree contains circular reference."), { name: "UnknownErrorException" })).message === UNREADABLE_MESSAGE
);
// Opening a file in the editor counts its pages first: a locked file and a
// broken one get different messages, named for the file.
{
  const locked = await protectPdf(good, { userPassword: "secret" });
  const lockedMessage = await getPageCount(locked).then(() => "", (err) => friendlyPdfError(err, "locked.pdf").message);
  check("editor: a locked file says so", lockedMessage === `locked.pdf: ${ENCRYPTED_MESSAGE}`, lockedMessage);
  const brokenMessage = await getPageCount(new TextEncoder().encode("%PDF-1.7\n")).then(() => "", (err) => friendlyPdfError(err, "bad.pdf").message);
  check("editor: a broken file says it isn't a PDF", brokenMessage === `bad.pdf: ${UNREADABLE_MESSAGE}`, brokenMessage);
}

check("our own messages still pass through", friendlyPdfError(new Error("Pick pages between 1 and 5.")).message === "Pick pages between 1 and 5.");

// Tools that take pictures or text never say "isn't a readable PDF".
check("file tools keep their own messages", friendlyFileError(new Error("notes.md: this file is nested too deeply to lay out.")).message === "notes.md: this file is nested too deeply to lay out.");
check("file tools: a bare library error is said plainly, not as a PDF", !/PDF/.test(friendlyFileError(new RangeError("Maximum call stack size exceeded")).message) && !/Cannot read/.test(friendlyFileError(new TypeError("Cannot read properties of undefined")).message));

// The browser failing to hold or read a file is no fault of the file: a
// RangeError from a failed allocation read "isn't a readable PDF. Try Repair
// PDF", and a file moved after it was picked showed the browser's sentence.
{
  const { MEMORY_MESSAGE, UNREAD_MESSAGE } = await import("../lib/pdf/errors.ts");
  const oom = new RangeError("Array buffer allocation failed");
  check("out of memory: said as memory, the file named", friendlyPdfError(oom, "big.pdf").message === `big.pdf: ${MEMORY_MESSAGE}`);
  check("out of memory: other wordings too", [new RangeError("Invalid array length"), new RangeError("Invalid typed array length: 4000000000"), new RangeError("Out of memory")].every((e) => friendlyPdfError(e).message === MEMORY_MESSAGE));
  check("a looping file is still unreadable, not memory", friendlyPdfError(new RangeError("Maximum call stack size exceeded")).message === UNREADABLE_MESSAGE);
  const gone = Object.assign(new Error("The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired."), { name: "NotReadableError" });
  const moved = Object.assign(new Error("A requested file or directory could not be found at the time an operation was processed."), { name: "NotFoundError" });
  check("a file that can't be read again: asked to choose it again", friendlyPdfError(gone).message === UNREAD_MESSAGE && friendlyPdfError(moved, "a.pdf").message === `a.pdf: ${UNREAD_MESSAGE}`);
  check("file tools say the same", friendlyFileError(oom).message === MEMORY_MESSAGE && friendlyFileError(gone).message === UNREAD_MESSAGE);
}

// After the message, a link to the tool that can help: never to the page that failed.
const { errorFix } = await import("../components/tools/file-pick.ts");
const one = [{ name: "a.pdf" }];
const fixOf = (message: string | null, slug: string) => errorFix(message, one, slug);
check("an unreadable PDF points at Repair PDF", fixOf(`a.pdf: ${UNREADABLE_MESSAGE}`, "crop-pdf")?.slug === "repair-pdf" && fixOf(UNREADABLE_MESSAGE, "merge-pdf")?.label === "Try Repair PDF");
check("Repair PDF doesn't point at itself", fixOf(UNREADABLE_MESSAGE, "repair-pdf") === null);
check("a locked PDF points at Unlock PDF, from Repair too", fixOf("This PDF is password-protected. Unlock it first.", "crop-pdf")?.slug === "unlock-pdf" && fixOf("This PDF is password-protected. Unlock it first, then repair it.", "repair-pdf")?.slug === "unlock-pdf" && fixOf("This PDF is password-protected. Unlock it first.", "unlock-pdf") === null);
check("other messages get no link", fixOf("Pick pages between 1 and 5.", "split-pdf") === null && fixOf(null, "split-pdf") === null);
{
  const { MEMORY_MESSAGE, UNREAD_MESSAGE } = await import("../lib/pdf/errors.ts");
  check("neither points at Repair PDF", fixOf(MEMORY_MESSAGE, "compress-pdf") === null && fixOf(`a.pdf: ${UNREAD_MESSAGE}`, "merge-pdf") === null);
}
// Merge names the damaged file, and that file is the one taken to Repair PDF.
const named = errorFix(`b.pdf: ${UNREADABLE_MESSAGE}`, [{ name: "a.pdf" }, { name: "b.pdf" }], "merge-pdf");
check("merge: the damaged file named goes to Repair PDF", named?.slug === "repair-pdf" && named.file.name === "b.pdf", named);
// With several files and no name, there's no telling which to send.
check("several files, no name: no guess", errorFix(UNREADABLE_MESSAGE, [{ name: "a.pdf" }, { name: "b.pdf" }], "organize-pdf") === null);

// The fix is a link: a new tab or window still opens it, and the address shows.
const { readFileSync } = await import("node:fs");
const help = readFileSync(new URL("../components/tools/ErrorHelp.tsx", import.meta.url), "utf8");
check("the fix is a link to the tool", /<Link\s+href=\{`\/tools\/\$\{fix\.slug\}`\}/.test(help) && !/<button/.test(help));
check("a modifier click is left to the browser", /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey\) return;\s*e\.preventDefault\(\);/.test(help));
// Every PDF page words a wrong file the same way.
const organizer = readFileSync(new URL("../components/tools/PageOrganizer.tsx", import.meta.url), "utf8");
check("page tools: a wrong file says what the tool takes", !organizer.includes("Choose a PDF file") && (organizer.match(/takesMessage\(getTool\(slug\)\?\.name, "application\/pdf"/g) ?? []).length === 2);
// The editor, Fill & Sign and Edit PDF Text offer the same fix, as a link, for a locked or broken file.
const launch = readFileSync(new URL("../components/tools/EditorLaunch.tsx", import.meta.url), "utf8");
check("editor: the fix goes through ErrorHelp with the failed file", /<ErrorHelp message=\{error\} slug=\{sign \? "sign-pdf" : text \? "edit-pdf-text" : "edit-pdf"\} files=\{failed \? \[failed\] : \[\]\} \/>/.test(launch) && !/<button/.test(launch));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
