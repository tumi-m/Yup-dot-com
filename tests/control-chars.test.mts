process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
// A font whose ToUnicode map turns glyphs into control characters (seen in
// PDFs with broken font maps) must not end up in the Word file: one such
// character makes word/document.xml invalid and Word refuses the file.
import JSZip from "jszip";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  beginText,
  endText,
  moveText,
  setFontAndSize,
  showText,
} from "pdf-lib";
import { parseDocument, toMarkdown } from "../lib/pdf/parse.ts";
import { toDocxBytes } from "../lib/pdf/convert.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const XML_ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;

const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const body = await pdf.embedFont(StandardFonts.Helvetica);
const broken = await pdf.embedFont(StandardFonts.Courier);
for (let i = 0; i < 6; i++) {
  page.drawText(`Normal body text line number ${i} for the paragraph.`, {
    x: 60, y: 740 - i * 16, size: 12, font: body,
  });
}
// "HiAB" at heading size, with A -> U+0001 and B -> U+0002.
const fontName = page.node.newFontDictionary("F9", broken.ref);
page.pushOperators(
  beginText(),
  setFontAndSize(fontName, 18),
  moveText(60, 780),
  showText(PDFHexString.of("48694142")),
  endText()
);
await pdf.save(); // embeds the fonts so the ToUnicode map can be attached
const cmap =
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def " +
  "1 begincodespacerange <00> <FF> endcodespacerange " +
  "2 beginbfchar <41> <0001> <42> <0002> endbfchar " +
  "endcmap CMapName currentdict /CMap defineresource pop end end";
(pdf.context.lookup(broken.ref) as unknown as { set(k: PDFName, v: unknown): void }).set(
  PDFName.of("ToUnicode"),
  pdf.context.register(pdf.context.stream(cmap))
);

const parsed = await parseDocument(await pdf.save());
const texts = parsed.blocks.map((b) => ("text" in b ? b.text : ""));
check("broken glyphs are dropped from the text", texts[0] === "Hi", JSON.stringify(texts[0]));
check("markdown has no control characters", !XML_ILLEGAL.test(toMarkdown(parsed)));

const docx = await toDocxBytes(parsed);
const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
check("word/document.xml has no XML-illegal characters", !XML_ILLEGAL.test(xml));
check("word/document.xml keeps the text", xml.includes(">Hi<") && xml.includes("line number 5"));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll control character checks passed.");
