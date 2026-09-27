process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseDocument, toMarkdown, extractTables } from "../lib/pdf/parse.ts";

/**
 * Regression: the gap between table columns was mistaken for a two-column
 * page gutter when only a single paragraph line crossed it. That moved the
 * paragraph above the title and tore the last column off the table.
 */
const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const helv = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
let y = 780;
const draw = (t: string, size: number, x = 60, f = helv) =>
  page.drawText(t, { x, y, size, font: f, color: rgb(0, 0, 0) });
draw("Quarterly Report", 24, 60, bold); y -= 45;
draw("Summary", 16, 60, bold); y -= 28;
draw("Revenue grew across every region this quarter, led by the north.", 11); y -= 36;
draw("By Region", 16, 60, bold); y -= 26;
for (const row of [["Region", "Revenue", "Growth"], ["North", "1,900,000", "18%"], ["Central", "1,400,000", "9%"], ["South", "900,000", "1%"]]) {
  row.forEach((c, i) => draw(c, 11, [60, 240, 400][i])); y -= 16;
}

const doc = await parseDocument(await pdf.save());
const md = toMarkdown(doc);
const tables = extractTables(doc);
console.log(md);

const titleFirst = md.trimStart().startsWith("# Quarterly Report");
const threeCols = tables.length === 1 && tables[0].rows.every((r) => r.length === 3);
const noStray = !md.includes("Growth 18%");
const ok = titleFirst && threeCols && noStray && md.includes("| North | 1,900,000 | 18% |");
console.log(ok ? "PASS: table columns are not mistaken for a page gutter"
  : `FAIL titleFirst=${titleFirst} threeCols=${threeCols} noStray=${noStray}`);
process.exit(ok ? 0 : 1);
