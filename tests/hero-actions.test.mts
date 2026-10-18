// The homepage offers tools for the files dropped on it. With several PDFs it
// used to offer Compress PDF, PDF to Word and Edit PDF, which then quietly
// kept the first file and dropped the rest.
import { heroActions, IMAGE_ACTIONS, MIXED_ACTIONS, MULTI_ACTIONS, PDF_ACTIONS, PPTX_ACTIONS, TAKES_ALL } from "../components/landing/hero-actions.ts";
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

check("every tool handed all files takes several", TAKES_ALL.every((s) => PROCESSORS[s]?.multiple), TAKES_ALL);
const slugs = new Set(TOOLS.map((t) => t.slug));
const unknown = [...PDF_ACTIONS, ...MULTI_ACTIONS, ...IMAGE_ACTIONS, ...PPTX_ACTIONS].filter((s) => !slugs.has(s));
check("every offered tool exists", unknown.length === 0, unknown);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
