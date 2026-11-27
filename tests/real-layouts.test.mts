process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  beginText,
  endText,
  setFontAndSize,
  moveText,
  showText,
} from "pdf-lib";
import { parseDocument, toMarkdown, extractTables } from "../lib/pdf/parse.ts";

/**
 * Layouts every office makes: a CV with a sidebar of short lines and bullets
 * from the Symbol font, an invoice whose descriptions wrap inside their cells
 * with totals under the last columns, a title that wraps onto a second line.
 */
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

// 1. A two-column CV: experience on the left, a sidebar on the right whose
// bullets are the Symbol font's private-use character, as Word and
// LibreOffice write them.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([612, 792]);
  // A font whose code B7 means U+F0B7, the Symbol bullet.
  const cmap = d.context.stream(
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Sym def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <B7> <F0B7> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
  );
  const sym = d.context.register(
    d.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica", Encoding: "WinAnsiEncoding", ToUnicode: d.context.register(cmap) })
  );
  p.node.setFontDictionary(PDFName.of("Sym"), sym);
  p.drawText("Lerato Mokoena", { x: 90, y: 700, size: 26, font: b });
  const left = [
    ["Experience", 14, b],
    ["Senior Data Analyst", 13, b],
    ["Standard Insights, 2022 to now", 11, f],
    ["Built weekly revenue dashboards used by", 11, f],
    ["forty branch managers and cut report", 11, f],
    ["preparation from two days to two hours.", 11, f],
    ["Data Analyst", 13, b],
    ["Mzansi Retail, 2019 to 2022", 11, f],
    ["Modelled stock levels for the stores and", 11, f],
    ["reduced the days they ran out of stock.", 11, f],
  ] as const;
  left.forEach(([t, size, font], i) => p.drawText(t, { x: 90, y: 640 - i * 15, size, font }));
  const right = ["Education", "BCom Statistics, Wits 2018", "Skills", "SQL", "Python", "Power BI", "Languages", "English, isiZulu", "References", "On request"];
  right.forEach((t, i) => {
    const y = 634 - i * 15;
    const item = i >= 3 && i <= 5;
    p.drawText(t, { x: item ? 342 : 324, y, size: i % 2 === 0 && !item ? 14 : 11, font: i % 2 === 0 && !item ? b : f });
    if (item) p.pushOperators(beginText(), setFontAndSize("Sym", 11), moveText(324, y), showText(PDFHexString.of("B7")), endText());
  });
  const md = toMarkdown(await parseDocument(await d.save()));
  const at = (s: string) => md.indexOf(s);
  check("the left column is read before the sidebar", at("reduced the days") >= 0 && at("reduced the days") < at("Education"), md.slice(0, 400));
  check("each column keeps its lines together", at("Standard Insights") < at("Built weekly") && at("Education") < at("BCom") && at("BCom") < at("Skills"));
  check("Symbol bullets make a list, not a table", /- SQL\n- Python\n- Power BI/.test(md) && !md.includes("|"), md.slice(at("Skills"), at("Skills") + 80));
}

// 2. An invoice table: two descriptions wrap onto a second line in their
// cell, and the totals stand under the last two columns.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  const xs = [90, 198, 306, 414];
  const row = (y: number, cells: (string | null)[]) => cells.forEach((c, i) => c && p.drawText(c, { x: xs[i], y, size: 11, font: f }));
  p.drawText("Thank you for your business.", { x: 90, y: 540, size: 11, font: f });
  row(500, ["Description", "Qty", "Unit price", "Amount"]);
  row(485, ["Logo redesign", "1", "4,500.00", "4,500.00"]);
  row(470, ["Website landing", "1", "12,000.00", "12,000.00"]);
  row(456.5, ["page", null, null, null]);
  row(442, ["Social media", "6", "375.50", "2,253.00"]);
  row(428.5, ["templates", null, null, null]);
  row(414, ["Hosting setup", "1", "1,200.00", "1,200.00"]);
  row(399.5, [null, null, "Subtotal", "19,953.00"]);
  row(385, [null, null, "VAT 15%", "2,992.95"]);
  row(370.5, [null, null, "Total due", "22,945.95"]);
  p.drawText("Banking details: FNB, account 62812345678, branch 250655.", { x: 90, y: 330, size: 11, font: f });
  const doc = await parseDocument(await d.save());
  const tables = extractTables(doc);
  const rows = tables[0]?.rows ?? [];
  check("one table, wrapped cells and all", tables.length === 1 && rows.length === 8, JSON.stringify(tables.map((t) => t.rows)));
  check("a wrapped description is one cell", rows[2]?.join("|") === "Website landing page|1|12,000.00|12,000.00" && rows[3]?.[0] === "Social media templates", JSON.stringify(rows.slice(2, 4)));
  check("totals stay under their columns", rows[5]?.join("|") === "||Subtotal|19,953.00" && rows[7]?.join("|") === "||Total due|22,945.95", JSON.stringify(rows.slice(5)));
  const md = toMarkdown(doc);
  check("the text after the table stays out of it", /\n\nBanking details/.test(md) && md.indexOf("Thank you") < md.indexOf("Description"));
}

// 3. A title that wraps onto a second line is one heading; two headings a
// paragraph apart stay two.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([612, 792]);
  p.drawText("Kennisgewing aan ouers / Isaziso", { x: 72, y: 720, size: 26, font: b });
  p.drawText("kubazali", { x: 72, y: 690, size: 26, font: b });
  for (let i = 0; i < 4; i++) p.drawText("Geagte ouers, die skool se jaarlikse sportdag vind plaas op Saterdag.", { x: 72, y: 650 - i * 14, size: 11, font: f });
  p.drawText("Afrikaans", { x: 72, y: 580, size: 16, font: b });
  p.drawText("isiZulu", { x: 72, y: 540, size: 16, font: b });
  p.drawText("Bazali abathandekayo, usuku lwezemidlalo luzoba ngoMgqibelo.", { x: 72, y: 520, size: 11, font: f });
  const doc = await parseDocument(await d.save());
  const headings = doc.blocks.filter((x) => x.type === "heading").map((x) => (x as { text: string }).text);
  check("the wrapped title is one heading", headings[0] === "Kennisgewing aan ouers / Isaziso kubazali", JSON.stringify(headings));
  check("headings with space between stay apart", headings.includes("Afrikaans") && headings.includes("isiZulu"), JSON.stringify(headings));
}

// A cover's two short title lines, and numbered headings one under the other, stay apart.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([612, 792]);
  p.drawText("Northern Depot", { x: 72, y: 600, size: 28, font: b });
  p.drawText("Safety Review 2026", { x: 72, y: 566, size: 28, font: b });
  p.drawText("Prepared by the safety committee for the board meeting in March.", { x: 72, y: 520, size: 11, font: f });
  p.drawText("1. Introduction", { x: 72, y: 470, size: 16, font: b });
  p.drawText("2. Findings", { x: 72, y: 448, size: 16, font: b });
  for (let i = 0; i < 5; i++) p.drawText("The committee walked every aisle and spoke to drivers on all three shifts about near misses.", { x: 72, y: 420 - i * 14, size: 11, font: f });
  const doc = await parseDocument(await d.save());
  const headings = doc.blocks.filter((x) => x.type === "heading").map((x) => (x as { text: string }).text);
  check("a cover's short title lines stay two headings", headings.includes("Northern Depot") && headings.includes("Safety Review 2026"), JSON.stringify(headings));
  check("numbered headings one under the other stay apart", headings.includes("1. Introduction") && headings.includes("2. Findings"), JSON.stringify(headings));
}

// 4. A report printed from a browser: its date and title at the top of each
// page, its address and page count at the foot. They aren't part of the
// text, and a paragraph running on over the page break is one paragraph.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const body = "Load-shedding schedules change often so check the official schedule before you plan and";
  for (let n = 1; n <= 3; n++) {
    const p = d.addPage([595, 842]);
    p.drawText(`11/27/26, 10:0${n} PM`, { x: 24, y: 820, size: 8, font: f });
    p.drawText("How to plan for load-shedding | Example News", { x: 260, y: 820, size: 8, font: f });
    p.drawText("https://news.example/energy/load-shedding", { x: 24, y: 17, size: 8, font: f });
    p.drawText(`${n}/3`, { x: 560, y: 17, size: 8, font: f });
    // A slide-like title at the top of each page is the page's own.
    p.drawText(`Part ${n} of the guide`, { x: 40, y: 770, size: 20, font: b });
    for (let i = 0; i < 40; i++) p.drawText(i === 39 && n < 3 ? body : `${body} more.`, { x: 40, y: 740 - i * 16, size: 11, font: f });
    if (n > 1) p.drawText("continues on this page with the rest of the sentence.", { x: 40, y: 788, size: 11, font: f });
  }
  const doc = await parseDocument(await d.save());
  const md = toMarkdown(doc);
  check("the browser's header and footer are left out", !/PM|Example News|news\.example|\b\d\/3\b/.test(md), md.match(/.*(PM|Example News|news\.example).*/)?.[0]);
  check("each page's own title stays", [1, 2, 3].every((n) => md.includes(`Part ${n} of the guide`)));
  check("a sentence over the page break is one paragraph", md.includes("before you plan and continues on this page"), md.slice(md.indexOf("Part 2") - 300, md.indexOf("Part 2")));
}

// 5. Lines at the top and bottom of every page that are the document's own:
// body-size, bold or saying something new on each page.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  for (let n = 1; n <= 3; n++) {
    const p = d.addPage([595, 842]);
    p.drawText(`Section ${n}`, { x: 40, y: 815, size: 11, font: b });
    if (n > 1) p.drawText(`Balance brought forward ${n * 1000}.00`, { x: 40, y: 800, size: 10, font: f });
    for (let i = 0; i < 40; i++) p.drawText(`Clause ${n}.${i} The tenant shall keep the premises clean and in good repair at all times.`, { x: 40, y: 770 - i * 16, size: 10, font: f });
    if (n < 3) p.drawText(`Balance carried forward ${(n + 1) * 1000}.00`, { x: 40, y: 45, size: 10, font: f });
    p.drawText("Initials: Tenant ______ Landlord ______", { x: 40, y: 30, size: 10, font: f });
  }
  const md = toMarkdown(await parseDocument(await d.save()));
  const count = (s: string) => md.split(s).length - 1;
  check("bold section titles at the top of each page stay", count("Section ") === 3, md.slice(0, 200));
  check("balances carried and brought forward stay", count("carried forward") === 2 && count("brought forward") === 2);
  check("a line to initial on every page stays", count("Initials: Tenant") === 3);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll real-layout checks passed");
