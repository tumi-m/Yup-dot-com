process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { parseDocument, extractTables, tableToCsv } from "../lib/pdf/parse.ts";

/**
 * A table that runs over a page break comes out as one table (one CSV, one
 * sheet) with its header once, kept on the page it starts on.
 */
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};
const row = (p: PDFPage, f: PDFFont, y: number, cells: string[], cols = [60, 220, 380]) =>
  cells.forEach((c, i) => p.drawText(c, { x: cols[i], y, size: 10, font: f }));

async function ledger(opts: { repeatHeader?: boolean; between?: string; secondColumns?: number } = {}) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  let p = d.addPage([595, 842]);
  let y = 780;
  row(p, f, y, ["Invoice", "Customer", "Amount"]);
  y -= 16;
  for (let i = 1; i <= 51; i++) {
    if (y < 60) {
      // Page numbers at the foot of each page, a running header at the top.
      p.drawText(`Page ${d.getPageCount()}`, { x: 280, y: 30, size: 9, font: f });
      p = d.addPage([595, 842]);
      p.drawText("Ledger for 2026", { x: 60, y: 810, size: 9, font: f });
      y = 780;
      if (opts.between) {
        p.drawText(opts.between, { x: 60, y, size: 10, font: f });
        y -= 30;
      }
      if (opts.repeatHeader) {
        row(p, f, y, ["Invoice", "Customer", "Amount"]);
        y -= 16;
      }
    }
    const cells = [`INV-${1000 + i}`, `Customer ${i}`, (i * 13.5).toFixed(2), "paid"];
    row(p, f, y, d.getPageCount() > 1 && opts.secondColumns === 4 ? cells : cells.slice(0, 3), [60, 220, 380, 480]);
    y -= 16;
  }
  p.drawText(`Page ${d.getPageCount()}`, { x: 280, y: 30, size: 9, font: f });
  d.getPage(0).drawText("Ledger for 2026", { x: 60, y: 810, size: 9, font: f });
  return extractTables(await parseDocument(await d.save()));
}

{
  const tables = await ledger({ repeatHeader: true });
  const [t] = tables;
  check("one table across the page break", tables.length === 1, `got ${tables.length}`);
  check("52 rows: the header once and 51 invoices", t?.rows.length === 52 && t.rows.filter((r) => r[0] === "Invoice").length === 1, `rows ${t?.rows.length}`);
  check("rows in order", t?.rows[1][0] === "INV-1001" && t.rows[51][0] === "INV-1051");
  check("kept on the page it starts on", t?.page === 1);
  check("one CSV with the header first", tableToCsv(t).split("\r\n")[0] === "﻿Invoice,Customer,Amount");
}
{
  const tables = await ledger();
  check("without a repeated header too", tables.length === 1 && tables[0].rows.length === 52, `got ${tables.map((t) => t.rows.length)}`);
}
{
  const tables = await ledger({ between: "Table 2 lists the refunds made in the same months." });
  check("a paragraph between them keeps two tables", tables.length === 2, `got ${tables.length}`);
}
{
  const tables = await ledger({ secondColumns: 4 });
  check("a different number of columns keeps two tables", tables.length === 2, `got ${tables.length}`);
}

process.exit(failed ? 1 : 0);
