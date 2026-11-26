// The homepage offers tools for the files dropped on it. With several PDFs it
// used to offer Compress PDF, PDF to Word and Edit PDF, which then quietly
// kept the first file and dropped the rest.
import { addFiles, handoffType, heroActions, IMAGE_ACTIONS, MIXED_ACTIONS, MULTI_ACTIONS, PDF_ACTIONS, PPTX_ACTIONS, TAKES_ALL, TWO_ACTIONS, takePdfs, tooBigFor } from "../components/landing/hero-actions.ts";
import { LIMITS } from "../lib/limits.ts";
import { PROCESSORS } from "../components/tools/processors.ts";
import { TOOLS } from "../lib/tools.tsx";

let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failed++;
}

const pdf = { name: "a.pdf", type: "application/pdf" };
const jpg = { name: "b.jpg", type: "image/jpeg" };

const several = heroActions("pdf", [pdf, pdf, pdf]);
check("several PDFs: only tools that take them all", several.every((s) => TAKES_ALL.includes(s) && PROCESSORS[s]?.multiple), several);
const two = heroActions("pdf", [pdf, pdf]);
check("two PDFs: only tools that take them both", two.every((s) => TAKES_ALL.includes(s) && (PROCESSORS[s]?.multiple || s === "compare-pdf")), two);
check("several PDFs: Merge PDF offered", several.includes("merge-pdf"), several);
// A PDF and a photo used to offer Merge PDF, which dropped the photo and
// then asked for at least 2 files.
const takes = (slug: string, type: string) => (PROCESSORS[slug]?.accept ?? "").split(",").includes(type);
for (const files of [[pdf, jpg], [pdf, pdf, jpg], [jpg, pdf, { name: "c.png", type: "image/png" }]]) {
  const mixed = heroActions("pdf", files);
  const label = files.map((f) => f.type.split("/")[1]).join(" + ");
  check(`${label}: every tool offered takes every file`, mixed.every((s) => files.every((f) => takes(s, f.type))), mixed);
  check(`${label}: says to pick one kind`, mixed === MIXED_ACTIONS && mixed.length === 0, mixed);
}
for (const files of [[pdf, pdf], [jpg, jpg], [pdf], [jpg]]) {
  const offered = heroActions("pdf", files);
  const handed = (s: string) => (TAKES_ALL.includes(s) ? files : files.slice(0, 1));
  const label = files.map((f) => f.type.split("/")[1]).join(" + ");
  check(`${label}: every tool takes what it's handed`, offered.every((s) => !PROCESSORS[s] || handed(s).every((f) => takes(s, f.type))), offered);
}
const images = heroActions("pdf", [jpg, jpg]);
check("several images: only tools that take them all", images.every((s) => TAKES_ALL.includes(s) && PROCESSORS[s]?.multiple), images);

check("one PDF: every PDF tool", heroActions("pdf", [pdf]) === PDF_ACTIONS);
check("one image: JPG to PDF", heroActions("pdf", [jpg]) === IMAGE_ACTIONS);
check("PPTX: the slide tools", heroActions("pptx", [{ name: "s.pptx", type: "" }]) === PPTX_ACTIONS);

// Compare PDFs has a page of its own and takes exactly two: the original and the changed version.
const takesTwo = (s: string) => s === "compare-pdf";
check("every tool handed all files takes several", TAKES_ALL.every((s) => PROCESSORS[s]?.multiple || takesTwo(s)), TAKES_ALL);
check("two PDFs: Merge PDF and Compare PDFs", heroActions("pdf", [pdf, pdf]) === TWO_ACTIONS && TWO_ACTIONS.includes("compare-pdf") && TWO_ACTIONS.includes("merge-pdf"));
check("three PDFs: no Compare, it takes two", !heroActions("pdf", [pdf, pdf, pdf]).includes("compare-pdf"));
check("one PDF: Redact PDF is offered", PDF_ACTIONS.includes("redact-pdf"));
const slugs = new Set(TOOLS.map((t) => t.slug));
const unknown = [...PDF_ACTIONS, ...MULTI_ACTIONS, ...TWO_ACTIONS, ...IMAGE_ACTIONS, ...PPTX_ACTIONS].filter((s) => !slugs.has(s));
check("every offered tool exists", unknown.length === 0, unknown);

// One PDF, then another: the second joins the first, so Merge PDF is offered.
// It used to replace it, and one file never reaches Merge.
const file = (name: string, size = 100, lastModified = 1) => ({ name, size, lastModified, type: "application/pdf" });
const a = file("a.pdf");
const b = file("b.pdf");
const joined = addFiles([a], [b]);
check("a second PDF joins the first", joined.length === 2 && joined[0] === a && joined[1] === b, joined.map((f) => f.name));
check("two PDFs, one at a time: Merge PDF and Compare PDFs", heroActions("pdf", joined) === TWO_ACTIONS);
check("the same file again counts once", addFiles([a, b], [file("b.pdf")]).length === 2);
check("the same file twice in one pick counts once", addFiles([], [a, file("a.pdf")]).length === 1);
check("nothing new keeps the list as it is", addFiles([a], [file("a.pdf")]).length === 1 && addFiles([a], [file("a.pdf")])[0] === a);
check("same name, other size or date: another file", addFiles([a], [file("a.pdf", 200), file("a.pdf", 100, 2)]).length === 3);

// A file over the plan's limit is turned away on the homepage: a tool would
// drop it.
const MB = 1024 * 1024;
const big = file("big.pdf", 60 * MB);
check("guest: 60 MB is over the limit", tooBigFor("guest", [a, big]).length === 1 && tooBigFor("guest", [a, big])[0] === big);
check("free: 60 MB is over the limit", tooBigFor("free", [big]).length === 1);
check("pro: 60 MB is fine", tooBigFor("pro", [big]).length === 0 && tooBigFor("team", [big]).length === 0);
check("exactly the limit is fine", tooBigFor("guest", [file("edge.pdf", LIMITS.guest.maxFileBytes)]).length === 0);

// A file over the limit used to hide every tool, also for the files that fit
// and the ones chosen before; the only way out was to clear them all.
const joinBig = takePdfs("guest", [a], [b, big], true);
check("one too big joining: the others stay", joinBig.files.length === 2 && joinBig.files[0] === a && joinBig.files[1] === b, joinBig.files.map((f) => f.name));
check("one too big joining: named", joinBig.tooBig.length === 1 && joinBig.tooBig[0] === big);
check("two that fit then one too big: Merge PDF stays", heroActions("pdf", joinBig.files).includes("merge-pdf"));
const onlyBig = takePdfs("guest", [a, b], [big], true);
check("only a big one: the files there are kept as they are", onlyBig.files.length === 2 && onlyBig.tooBig[0] === big);
const fresh = takePdfs("guest", [a], [big, b], false);
check("starting afresh: only the ones that fit", fresh.files.length === 1 && fresh.files[0] === b && fresh.tooBig[0] === big);
check("pro: nothing turned away", takePdfs("pro", [], [a, big], false).tooBig.length === 0);

// iPhone photos, WebP, TIFF and SVG are pictures too, handed over with their own type.
const heic = { name: "IMG_0001.HEIC", type: "" };
const svg = { name: "logo.svg", type: "image/svg+xml" };
check("HEIC with no type: HEIC to PDF, which says up front if the browser can't open it", heroActions("pdf", [heic]).join() === "heic-to-pdf");
check("mixed picture formats: JPG to PDF", heroActions("pdf", [jpg, svg, { name: "a.webp", type: "image/webp" }, { name: "fax.tif", type: "" }]) === IMAGE_ACTIONS);
check("handoff: an untyped HEIC goes as image/heic", handoffType(heic) === "image/heic", handoffType(heic));
check("handoff: an untyped TIFF goes as image/tiff", handoffType({ name: "scan.TIFF", type: "" }) === "image/tiff");
check("handoff: JPG to PDF takes what it is handed", ["image/heic", "image/tiff", "image/svg+xml", "image/webp"].every((t) => PROCESSORS["jpg-to-pdf"].accept.includes(t)));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
