process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { parseDocument, toMarkdown, extractTables, toChunks } from "../lib/pdf/parse.ts";

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);

  let y = 780;
  const draw = (
    text: string,
    size: number,
    x = 60,
    font = helv
  ) => {
    page.drawText(text, { x, y, size, font, color: black });
  };

  // Title (24pt -> h1)
  draw("Quarterly Revenue Report", 24, 60, bold);
  y -= 45;

  // Section heading (16pt -> h2)
  draw("Executive Summary", 16, 60, bold);
  y -= 28;

  // Body paragraph, 11pt, tight line spacing
  const para = [
    "Revenue grew steadily across all three regions during the quarter.",
    "The northern territory outperformed forecasts by a wide margin, while",
    "the southern region held flat against the prior period.",
  ];
  for (const line of para) {
    draw(line, 11);
    y -= 14;
  }
  y -= 22;

  // Bulleted list
  draw("Key Highlights", 16, 60, bold);
  y -= 26;
  for (const item of [
    "- Total revenue reached 4.2 million dollars",
    "- Customer churn dropped to 2.1 percent",
    "- Two new enterprise accounts were signed",
  ]) {
    draw(item, 11);
    y -= 15;
  }
  y -= 26;

  // Table with clearly separated columns
  draw("Revenue by Region", 16, 60, bold);
  y -= 26;
  const cols = [60, 240, 400];
  const rows = [
    ["Region", "Revenue", "Growth"],
    ["North", "1,900,000", "18%"],
    ["Central", "1,400,000", "9%"],
    ["South", "900,000", "1%"],
  ];
  for (const row of rows) {
    row.forEach((cell, i) => draw(cell, 11, cols[i]));
    y -= 16;
  }

  return doc.save();
}

const bytes = await makePdf();
console.log(`Generated test PDF: ${bytes.length} bytes\n`);

const parsed = await parseDocument(bytes);
console.log("bodySize:", parsed.bodySize.toFixed(2), "| likelyScanned:", parsed.likelyScanned);
console.log("blocks:", parsed.blocks.map((b) => b.type).join(", "));
console.log("\n===== MARKDOWN =====");
console.log(toMarkdown(parsed));
console.log("===== TABLES =====");
const tables = extractTables(parsed);
console.log("table count:", tables.length);
tables.forEach((t) => console.log(JSON.stringify(t.rows)));
console.log("\n===== CHUNKS =====");
for (const c of toChunks(parsed, 400)) {
  console.log(`[path: "${c.path}" p${c.page}] ${c.text.slice(0, 70).replace(/\n/g, " / ")}...`);
}
process.exit(0);
