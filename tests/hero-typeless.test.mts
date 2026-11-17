// A photo with no type (a share sheet, some phone pickers) got in by its
// name, but the homepage counted pictures by type alone: it offered the PDF
// tools for it ("Couldn't open that PDF"), and Merge PDF for a PDF and that
// photo. It was also handed on as a PDF.
import { handoffType, heroActions, IMAGE_ACTIONS, MIXED_ACTIONS, PDF_ACTIONS, PPTX_TYPE, TAKES_ALL } from "../components/landing/hero-actions.ts";
import { PROCESSORS } from "../components/tools/processors.ts";

let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failed++;
}

const photo = { name: "IMG_1.jpg", type: "" };
const pdf = { name: "doc.pdf", type: "application/pdf" };

check("a photo with no type: JPG to PDF, not the PDF tools", heroActions("pdf", [photo]) === IMAGE_ACTIONS, heroActions("pdf", [photo]));
check("a PDF and a photo with no type: says to pick one kind", heroActions("pdf", [pdf, photo]) === MIXED_ACTIONS, heroActions("pdf", [pdf, photo]));
check("photos with no type: JPG to PDF", heroActions("pdf", [photo, { name: "Screenshot.PNG", type: "" }, { name: "b.jpeg", type: "" }]) === IMAGE_ACTIONS);
check("a PDF with no type is still a PDF", heroActions("pdf", [{ name: "scan.pdf", type: "" }]) === PDF_ACTIONS);

check("a photo with no type is handed on as a JPEG", handoffType(photo) === "image/jpeg", handoffType(photo));
check("a PNG with no type is handed on as a PNG", handoffType({ name: "Screenshot.PNG", type: "" }) === "image/png");
check("a PPTX with no type is handed on as a PPTX", handoffType({ name: "deck.pptx", type: "" }) === PPTX_TYPE);
check("a PDF with no type is handed on as a PDF", handoffType({ name: "scan.pdf", type: "" }) === "application/pdf");
check("a type the browser gave is kept", handoffType({ name: "x.jpg", type: "image/png" }) === "image/png");

// Text and Markdown files have tools of their own; one picture format, its own page.
const { choiceForFiles } = await import("../lib/journey.ts");
const notes = { name: "notes.txt", type: "" };
const readme = { name: "README.md", type: "" };
check("a .txt opens the file branch with TXT to PDF first", choiceForFiles([notes]) === "pdf" && heroActions("pdf", [notes])[0] === "txt-to-pdf", heroActions("pdf", [notes]));
check("a .md offers Markdown to PDF first", heroActions("pdf", [readme])[0] === "markdown-to-pdf", heroActions("pdf", [readme]));
check("text with a PDF: pick one kind", heroActions("pdf", [notes, { name: "a.pdf", type: "application/pdf" }]) === MIXED_ACTIONS);
check("a TIFF scan goes to TIFF to PDF", heroActions("pdf", [{ name: "scan.tiff", type: "image/tiff" }]).join() === "tiff-to-pdf");
check("an SVG logo goes to SVG to PDF", heroActions("pdf", [{ name: "logo.svg", type: "" }]).join() === "svg-to-pdf");
check("two formats together: JPG to PDF, which takes them all", heroActions("pdf", [{ name: "a.png", type: "" }, { name: "b.svg", type: "" }]) === IMAGE_ACTIONS);

// The tool takes the file as it is handed on.
const takes = (slug: string, type: string) => [PROCESSORS[slug]?.accept, PROCESSORS[slug]?.alsoAccepts].join(",").split(",").includes(type);
for (const files of [[photo], [photo, { name: "b.png", type: "" }], [notes], [readme], [{ name: "scan.tif", type: "" }, { name: "scan2.TIFF", type: "" }], [{ name: "logo.svg", type: "" }]]) {
  const offered = heroActions("pdf", files);
  const handed = (s: string) => (TAKES_ALL.includes(s) ? files : files.slice(0, 1));
  check(`${files.map((f) => f.name).join(" + ")}: every tool takes what it's handed`, offered.length > 0 && offered.every((s) => handed(s).every((f) => takes(s, handoffType(f)))), offered);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
