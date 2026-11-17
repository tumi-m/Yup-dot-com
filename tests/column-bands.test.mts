process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { parseDocument, toPlainText, extractTables } from "../lib/pdf/parse.ts";

/**
 * Pages that mix full-width text with two columns: each part is read where it
 * stands, columns left then right, and a table under the columns keeps all
 * its columns instead of being cut at the gutter.
 */
const words = "the river flows past the old mill and turns toward the valley where farmers grow maize and beans each season".split(" ");
const sentence = (k: number, n: number) => Array.from({ length: n }, (_, i) => words[(k * 7 + i) % words.length]).join(" ");
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

async function columns(p: PDFPage, f: PDFFont, top: number, rows: number) {
  for (let i = 0; i < rows; i++) {
    p.drawText(`L${i + 1} ` + sentence(i, 7), { x: 72, y: top - i * 12, size: 10, font: f });
    p.drawText(`R${i + 1} ` + sentence(i + 3, 7), { x: 324, y: top - i * 12, size: 10, font: f });
  }
}

// 1. Title, a full-width abstract, two columns of 30 lines, a centred page number.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.TimesRoman);
  const b = await d.embedFont(StandardFonts.TimesRomanBold);
  const p = d.addPage([612, 792]);
  p.drawText("Water Use in Rural Districts", { x: 180, y: 740, size: 18, font: b });
  for (let i = 0; i < 3; i++) p.drawText(`A${i + 1} ` + sentence(i, 16), { x: 72, y: 710 - i * 12, size: 10, font: f });
  await columns(p, f, 660, 30);
  p.drawText("3", { x: 303, y: 40, size: 10, font: f });
  const text = toPlainText(await parseDocument(await d.save()));
  const order = [...text.matchAll(/\b([ALR]\d+)\b/g)].map((m) => m[1]);
  const want = [...[1, 2, 3].map((n) => `A${n}`), ...Array.from({ length: 30 }, (_, n) => `L${n + 1}`), ...Array.from({ length: 30 }, (_, n) => `R${n + 1}`)];
  check("abstract, then the left column, then the right", order.join(" ") === want.join(" "), order.slice(0, 10).join(" "));
  check("no tabs between the columns", !text.includes("\t"));
  check("title first", text.startsWith("Water Use in Rural Districts"));
}

// 2. A three-column ledger under a full-width heading, below two columns.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([612, 792]);
  await columns(p, f, 740, 20);
  p.drawText("Ledger of the season's accounts", { x: 220, y: 480, size: 14, font: f });
  for (let r = 0; r <= 10; r++) {
    const cells = r ? [`INV-${1000 + r}`, `Customer ${r}`, (r * 13.5).toFixed(2)] : ["Invoice", "Customer", "Amount"];
    cells.forEach((c, i) => p.drawText(c, { x: [72, 230, 400][i], y: 450 - r * 14, size: 10, font: f }));
  }
  const doc = await parseDocument(await d.save());
  const tables = extractTables(doc);
  check("the ledger keeps its three columns", tables.length === 1 && tables[0].rows.length === 11 && tables[0].rows.every((r) => r.length === 3),
    JSON.stringify(tables.map((t) => t.rows[0])));
  const text = toPlainText(doc);
  check("columns read before the heading and table", text.indexOf("R20") < text.indexOf("Ledger") && text.indexOf("L20") < text.indexOf("R1 "));
}

// 3. As word processors lay it out: the heading and its intro line sit at the
// left under the columns, and no line of the table crosses the gutter.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const b = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([595, 842]);
  for (let i = 0; i < 20; i++) {
    p.drawText(`L${i + 1} ` + sentence(i, 6), { x: 57, y: 760 - i * 12, size: 10, font: f });
    p.drawText(`R${i + 1} ` + sentence(i + 3, 6), { x: 306, y: 760 - i * 12, size: 10, font: f });
  }
  p.drawText("Ledger", { x: 57, y: 500, size: 14, font: b });
  p.drawText("See the full ledger online.", { x: 57, y: 484, size: 10, font: f });
  for (let r = 0; r <= 8; r++) {
    const cells = r ? [`INV-${1000 + r}`, `Customer ${r}`, (r * 13.5).toFixed(2)] : ["Invoice", "Customer", "Amount"];
    cells.forEach((c, i) => p.drawText(c, { x: [57, 217, 378][i], y: 466 - r * 12, size: 10, font: f }));
  }
  const doc = await parseDocument(await d.save());
  const tables = extractTables(doc);
  check("a table under the columns keeps its columns", tables.length === 1 && tables[0].rows.length === 9 && tables[0].rows.every((r) => r.length === 3),
    JSON.stringify(tables.map((t) => t.rows[0])));
  const text = toPlainText(doc);
  check("the heading follows both columns", text.indexOf("R20") < text.indexOf("Ledger") && text.indexOf("L20") < text.indexOf("R1 "));
}

process.exit(failed ? 1 : 0);
