// Arabic and Hebrew text read right to left. Chromium (Chrome's and Google
// Docs' "Save as PDF") writes Arabic one joined letter shape at a time, left
// to right as it shows, in U+FExx presentation forms. Text, Markdown, CSV and
// Word used to come out reversed and in those shapes, which nothing finds in
// a search, and RTL tables came out mirrored.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import JSZip from "jszip";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
  type PDFPage,
} from "pdf-lib";
import { extractTables, parseDocument, tableToCsv, toMarkdown, toPlainText } from "../lib/pdf/parse.ts";
import { toDocxBytes } from "../lib/pdf/convert.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

/** Pieces of text as drawn, left to right on the page: [text, width in ems]. */
type Piece = [string, number];

const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
// One code per piece, from "!" on; ToUnicode says what each one stands for.
const FIRST = 0x21;
const codes = new Map<string, number>();
const widths: number[] = [];
const code = ([text, em]: Piece) => {
  const key = `${text}|${em}`;
  if (!codes.has(key)) {
    codes.set(key, FIRST + codes.size);
    widths.push(Math.round(em * 1000));
  }
  return codes.get(key)!;
};
const hex = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
const utf16 = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()).join("");

/** Draws `pieces` one by one from `x`, each in its own text object, as Chromium does. */
function line(p: PDFPage, x: number, y: number, size: number, pieces: Piece[], gaps: Record<number, number> = {}) {
  pieces.forEach((piece, i) => {
    p.pushOperators(
      beginText(),
      setFontAndSize("F1", size),
      setTextMatrix(1, 0, 0, 1, x, y),
      showText(PDFHexString.of(hex(code(piece)))),
      endText()
    );
    x += piece[1] * size + (gaps[i] ?? 0);
  });
}
const word = (shapes: string, em = 0.5): Piece[] => Array.from(shapes, (c) => [c, em] as Piece);

// "تقرير المبيعات", as shown: المبيعات on the left, تقرير on the right.
line(page, 300, 780, 24, [...word("ﺕﺎﻌﻴﺒﻤﻟﺍ"), ...word("ﺮﻳﺮﻘﺗ")], { 7: 6 });
// "هذا نص عربي فيه PDF Wizard": the English name, in two pieces, shows on the left.
line(page, 200, 740, 12, [["PDF", 1.6], ["Wizard", 3], ...word("ﻪﻴﻓ"), ...word("ﻲﺑﺮﻋ"), ...word("ﺺﻧ"), ...word("ﺍﺬﻫ")], {
  0: 3,
  1: 3,
  4: 3,
  8: 3,
  10: 3,
});
// A table, columns from the right: الاسم | المدينة | العمر
const row = (y: number, cells: Piece[][]) => {
  // cells are given right to left; drawn left to right
  [...cells].reverse().forEach((pieces, i) => line(page, 60 + i * 90, y, 12, pieces));
};
row(700, [word("ﻢﺳﻻﺍ"), word("ﺔﻨﻳﺪﻤﻟﺍ"), word("ﺮﻤﻌﻟﺍ")]);
row(682, [word("ﺪﻤﺣﺃ"), word("ﺓﺮﻫﺎﻘﻟﺍ"), [["30", 1.1]]]);
row(664, [word("ﺓﺭﺎﺳ"), word("ﻲﺑﺩ"), [["25", 1.1]]]);
// An English line with an Arabic name drawn shape by shape.
line(page, 60, 620, 12, [["Signed by", 4.6], ...word("ﺪﻤﺣﺃ")], { 0: 4 });

const cmap = [
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
  "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
  "/CMapName /Adobe-Identity-UCS def /CMapType 2 def",
  "1 begincodespacerange <00> <FF> endcodespacerange",
  `${codes.size} beginbfchar`,
  ...[...codes].map(([key, n]) => `<${hex(n)}> <${utf16(key.split("|")[0])}>`),
  "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end",
].join("\n");
const font = doc.context.register(
  doc.context.obj({
    Type: "Font",
    Subtype: "Type1",
    BaseFont: "Helvetica",
    FirstChar: FIRST,
    LastChar: FIRST + codes.size - 1,
    Widths: widths,
    ToUnicode: doc.context.register(doc.context.stream(cmap)),
  })
);
page.node.setFontDictionary(PDFName.of("F1"), font);
const bytes = await doc.save();

const parsed = await parseDocument(bytes);
const text = toPlainText(parsed);
console.log(text);
check("heading reads right to left, in plain letters", text.startsWith("تقرير المبيعات\n"), text.split("\n")[0]);
check("no presentation forms are left", !/[\uFB50-\uFDFF\uFE70-\uFEFE]/.test(text));
check("an English name inside Arabic keeps its order", text.includes("\nهذا نص عربي فيه PDF Wizard\n"), text.split("\n\n")[1]);
check("an Arabic name inside English reads right", text.includes("Signed by أحمد"), text.split("\n\n").pop());

const md = toMarkdown(parsed);
check("Markdown heading reads right", md.startsWith("# تقرير المبيعات"), md.split("\n")[0]);

const tables = extractTables(parsed);
const csv = tables.length ? tableToCsv(tables[0]) : "";
check(
  "table columns run from the right, cells read right",
  csv === "\uFEFFالاسم,المدينة,العمر\r\nأحمد,القاهرة,30\r\nسارة,دبي,25\r\n",
  csv
);

const docx = await JSZip.loadAsync(await toDocxBytes(parsed));
const xml = await docx.file("word/document.xml")!.async("string");
check("Word marks the Arabic heading right to left", /<w:bidi\/>[\s\S]*?تقرير المبيعات/.test(xml) && /<w:rtl\/>/.test(xml));
check("Word lays the table out from the right", /<w:bidiVisual\/>/.test(xml));
check("Word leaves English paragraphs alone", !/<w:bidi\/>(?:(?!<\/w:p>)[\s\S])*Signed by/.test(xml));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
