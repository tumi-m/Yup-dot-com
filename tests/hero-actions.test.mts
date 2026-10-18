// The homepage offers tools for the files dropped on it. With several PDFs it
// used to offer Compress PDF, PDF to Word and Edit PDF, which then quietly
// kept the first file and dropped the rest.
import { heroActions, IMAGE_ACTIONS, MULTI_ACTIONS, PDF_ACTIONS, PPTX_ACTIONS, TAKES_ALL } from "../components/landing/hero-actions.ts";
import { PROCESSORS } from "../components/tools/processors.ts";
import { TOOLS } from "../lib/tools.tsx";

let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failed++;
}

const pdf = { type: "application/pdf" };
const jpg = { type: "image/jpeg" };

const several = heroActions("pdf", [pdf, pdf, pdf]);
check("several PDFs: only tools that take them all", several.every((s) => TAKES_ALL.includes(s) && PROCESSORS[s]?.multiple), several);
check("several PDFs: Merge PDF offered", several.includes("merge-pdf"), several);
const mixed = heroActions("pdf", [pdf, jpg]);
check("PDFs and images: only tools that take them all", mixed.every((s) => TAKES_ALL.includes(s) && PROCESSORS[s]?.multiple), mixed);
const images = heroActions("pdf", [jpg, jpg]);
check("several images: only tools that take them all", images.every((s) => TAKES_ALL.includes(s) && PROCESSORS[s]?.multiple), images);

check("one PDF: every PDF tool", heroActions("pdf", [pdf]) === PDF_ACTIONS);
check("one image: JPG to PDF", heroActions("pdf", [jpg]) === IMAGE_ACTIONS);
check("PPTX: the slide tools", heroActions("pptx", [{ type: "" }]) === PPTX_ACTIONS);

check("every tool handed all files takes several", TAKES_ALL.every((s) => PROCESSORS[s]?.multiple), TAKES_ALL);
const slugs = new Set(TOOLS.map((t) => t.slug));
const unknown = [...PDF_ACTIONS, ...MULTI_ACTIONS, ...IMAGE_ACTIONS, ...PPTX_ACTIONS].filter((s) => !slugs.has(s));
check("every offered tool exists", unknown.length === 0, unknown);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
