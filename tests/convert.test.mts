process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseDocument, extractTables } from "../lib/pdf/parse.ts";
import { toDocxBytes, tablesToXlsx, parseNumeric } from "../lib/pdf/convert.ts";

// Same fixture shape as parse.test: title, section, paragraph, list, table.
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const helv = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
let y = 780;
const draw = (t: string, size: number, x = 60, f = helv) =>
  page.drawText(t, { x, y, size, font: f, color: rgb(0, 0, 0) });
draw("Quarterly Report", 24, 60, bold); y -= 45;
draw("Summary", 16, 60, bold); y -= 28;
draw("Revenue grew across every region this quarter.", 11); y -= 36;
draw("Steps", 16, 60, bold); y -= 26;
for (const s of ["1. Collect receipts", "2. Reconcile ledger", "3. File report"]) { draw(s, 11); y -= 15; }
y -= 26;
draw("By Region", 16, 60, bold); y -= 26;
for (const row of [["Region", "Revenue", "Growth"], ["North", "1,900,000", "18%"], ["South", "(900)", "1%"]]) {
  row.forEach((c, i) => draw(c, 11, [60, 240, 400][i])); y -= 16;
}
const parsed = await parseDocument(await pdf.save());

const dir = process.env.TMPDIR || "/tmp";
writeFileSync(`${dir}/wizard-test.docx`, await toDocxBytes(parsed, "Quarterly Report"));
writeFileSync(`${dir}/wizard-test.xlsx`, await tablesToXlsx(extractTables(parsed)));

// Read both files back with independent Python libraries.
const report = execFileSync("python3", ["-c", `
import docx, openpyxl, json
d = docx.Document("${dir}/wizard-test.docx")
paras = [(p.style.name, p.text) for p in d.paragraphs if p.text]
t = d.tables[0]
wb = openpyxl.load_workbook("${dir}/wizard-test.xlsx")
ws = wb.worksheets[0]
print(json.dumps({
  "paras": paras,
  "table": [[c.text for c in r.cells] for r in t.rows],
  "sheet": wb.sheetnames[0],
  "cells": [[c.value for c in r] for r in ws.iter_rows()],
  "numbered": sum(1 for p in d.paragraphs if p._p.pPr is not None and p._p.pPr.numPr is not None),
}))
`]).toString();
const r = JSON.parse(report);
console.log("word paragraphs:", JSON.stringify(r.paras));
console.log("word table:", JSON.stringify(r.table));
console.log("numbered list items:", r.numbered);
console.log("excel sheet:", r.sheet, JSON.stringify(r.cells));

const styles = Object.fromEntries(r.paras.map(([s, t]: [string, string]) => [t, s]));
const ok =
  styles["Quarterly Report"] === "Heading 1" &&
  styles["Summary"] === "Heading 2" &&
  r.numbered === 3 &&
  r.table[1][1] === "1,900,000" &&
  r.cells[1][1] === 1900000 &&        // numeric, so spreadsheets can sum it
  r.cells[2][1] === -900 &&           // accounting negative
  r.cells[1][2] === "18%" &&          // percentages kept as text
  parseNumeric("12abc") === null;
console.log(ok ? "\nPASS: Word/Excel output opens in independent readers with real structure" : "\nFAIL");
process.exit(ok ? 0 : 1);
