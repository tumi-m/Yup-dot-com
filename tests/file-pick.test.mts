// What a tool page keeps from one pick or drop. One file over the size limit
// used to throw away every file picked with it, without saying which one; a
// one-file tool kept the first of several dropped files without a word; and
// a big saving read "100% smaller".
import { errorFix, percentSmaller, sortPick, splitNameEnd } from "../components/tools/file-pick.ts";
import { ENCRYPTED_MESSAGE, SCANNED_MESSAGE, UNREADABLE_MESSAGE } from "../lib/pdf/errors.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const MB = 1024 * 1024;
const pdf = (name: string, size: number) => {
  const f = new File([], name, { type: "application/pdf" });
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const names = (files: File[]) => files.map((f) => f.name).join();
const merge = { maxFileBytes: 50 * MB, multiple: true, toolName: "Merge PDF" };
const compress = { maxFileBytes: 50 * MB, multiple: false, toolName: "Compress PDF" };

const clean = sortPick([pdf("a.pdf", 1000), pdf("b.pdf", 2000)], 0, merge);
check("all fit: all kept, nothing said", names(clean.keep) === "a.pdf,b.pdf" && clean.message === null && clean.tooBig === 0, clean);

const oneBig = sortPick([pdf("a.pdf", 1000), pdf("b.pdf", 2000), pdf("big.pdf", 54 * MB)], 0, merge);
check("one too big: the others are kept", names(oneBig.keep) === "a.pdf,b.pdf", names(oneBig.keep));
check("one too big: named", oneBig.message === "big.pdf is over 50 MB, the limit on your plan.", oneBig.message);
check("one too big: counted for the upgrade prompt", oneBig.tooBig === 1);

const twoBig = sortPick([pdf("big.pdf", 54 * MB), pdf("big2.pdf", 60 * MB)], 0, merge);
check("all too big: nothing kept", twoBig.keep.length === 0 && twoBig.tooBig === 2);
check("several too big: counted", twoBig.message === "2 files are over 50 MB, the limit on your plan.", twoBig.message);

const exact = sortPick([pdf("edge.pdf", 50 * MB)], 0, merge);
check("exactly the limit fits", exact.keep.length === 1 && exact.message === null);

const single = sortPick([pdf("a.pdf", 1000), pdf("b.pdf", 2000)], 0, compress);
check("one-file tool keeps the first", names(single.keep) === "a.pdf");
check("one-file tool says so", single.message === "Compress PDF takes one file at a time. Using a.pdf.", single.message);
const unnamed = sortPick([pdf("a.pdf", 1000), pdf("b.pdf", 2000)], 0, { ...compress, toolName: undefined });
check("one-file tool without a name", unnamed.message === "This tool takes one file at a time. Using a.pdf.", unnamed.message);

const mixed = sortPick([pdf("big.pdf", 54 * MB), pdf("a.pdf", 1000), pdf("b.pdf", 2000)], 2, compress);
check("notes are joined, none lost", mixed.message === "big.pdf is over 50 MB, the limit on your plan. Skipped 2 unsupported files. Compress PDF takes one file at a time. Using a.pdf.", mixed.message);
check("too big file never chosen as the one", names(mixed.keep) === "a.pdf");
check("skipped alone", sortPick([pdf("a.pdf", 1000)], 1, merge).message === "Skipped 1 unsupported file.");

check("percent: rounds down", percentSmaller(0.426) === 42);
check("percent: never 100", percentSmaller(0.997) === 99 && percentSmaller(1) === 99);
check("percent: small savings", percentSmaller(0.05) === 5);

// The success card truncates a name in the middle. Cutting it by UTF-16 units
// split the last emoji of "Résumé 📄📄📄📄📄📄📄-page-2.pdf" across the two halves.
const lone = (s: string) => /[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(s);
const emoji = splitNameEnd("Résumé 📄📄📄📄📄📄📄-page-2.pdf");
check("emoji name: no half emoji either side", !lone(emoji[0]) && !lone(emoji[1]), emoji);
check("emoji name: the end is the last 12 characters", emoji[1] === "📄-page-2.pdf" && emoji.join("") === "Résumé 📄📄📄📄📄📄📄-page-2.pdf", emoji);
const family = splitNameEnd("x".repeat(20) + "👨‍👩‍👧-page-2.pdf");
check("joined emoji stays whole", family[1] === "👨‍👩‍👧-page-2.pdf", family);
const accent = splitNameEnd("cafe\u0301-page-1.pdf");
check("accent stays on its letter", accent[0] === "caf" && accent[1] === "e\u0301-page-1.pdf", accent);
check("short name: all in the end", JSON.stringify(splitNameEnd("a.pdf")) === JSON.stringify(["", "a.pdf"]));
check("plain name: as before", JSON.stringify(splitNameEnd("report-final-page-12.jpg")) === JSON.stringify(["report-final", "-page-12.jpg"]));

// An error that another tool fixes offers that tool, with the file it is about.
const one = [pdf("scan.pdf", 1000)];
const two = [pdf("a.pdf", 1000), pdf("locked.pdf", 1000)];
const fixOf = (message: string | null, files: File[], slug: string) => {
  const fix = errorFix(message, files, slug);
  return fix ? `${fix.slug}:${fix.label}:${fix.file.name}` : null;
};
check("scan: Run OCR PDF", fixOf(SCANNED_MESSAGE, one, "pdf-to-word") === "ocr-pdf:Run OCR PDF:scan.pdf", fixOf(SCANNED_MESSAGE, one, "pdf-to-word"));
check("password: Open in Unlock PDF", fixOf(ENCRYPTED_MESSAGE, one, "compress-pdf") === "unlock-pdf:Open in Unlock PDF:scan.pdf");
check("merge: the named file goes, not the first", fixOf(`locked.pdf: ${ENCRYPTED_MESSAGE}`, two, "merge-pdf") === "unlock-pdf:Open in Unlock PDF:locked.pdf");
check("merge: no name, no guess", fixOf(ENCRYPTED_MESSAGE, two, "merge-pdf") === null);
check("not offered on the tool itself", fixOf(ENCRYPTED_MESSAGE, one, "unlock-pdf") === null && fixOf(SCANNED_MESSAGE, one, "ocr-pdf") === null);
check("nothing for other errors", fixOf(UNREADABLE_MESSAGE, one, "compress-pdf") === null && fixOf(null, one, "compress-pdf") === null);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
