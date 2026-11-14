// What a tool page keeps from one pick or drop. One file over the size limit
// used to throw away every file picked with it, without saying which one; a
// one-file tool kept the first of several dropped files without a word; and
// a big saving read "100% smaller".
import { percentSmaller, sortPick } from "../components/tools/file-pick.ts";

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

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
