// PDF to RAG Chunks: heading breadcrumbs and chunk sizes.
import { toChunks, type Block, type ParsedDocument } from "../lib/pdf/parse.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed++;
}

const doc = (blocks: Block[]): ParsedDocument => ({
  blocks,
  pageCount: Math.max(1, ...blocks.map((b) => b.page)),
  bodySize: 11,
  likelyScanned: false,
});
const heading = (level: number, text: string, page = 1): Block => ({ type: "heading", level, text, page });
const para = (text: string, page = 1): Block => ({ type: "paragraph", text, page });

// Headings that parse as h3 (14pt bold over 11pt body) with no h1/h2 above.
const paths = toChunks(
  doc([heading(3, "Revenue"), para("Revenue grew."), heading(3, "Costs"), para("Costs fell.")])
).map((c) => c.path);
check("top-level h3 headings have no empty segments", JSON.stringify(paths) === '["Revenue","Costs"]', JSON.stringify(paths));

const mixed = toChunks(
  doc([
    heading(1, "Report"),
    heading(3, "Revenue"),
    para("Revenue grew."),
    heading(2, "Outlook"),
    para("Steady."),
  ])
).map((c) => c.path);
check(
  "skipped levels are left out and deeper levels reset",
  JSON.stringify(mixed) === '["Report > Revenue","Report > Outlook"]',
  JSON.stringify(mixed)
);

// One long paragraph must be split to the chosen size ("Small (600)").
const sentence = "Revenue grew by twelve percent across all regions this year. ";
const longPara = sentence.repeat(80).trim();
const small = toChunks(doc([heading(2, "Results"), para(longPara, 2)]), 600);
check("a long paragraph is split", small.length > 1, `${small.length} chunk(s)`);
check("no chunk is over the chosen size", small.every((c) => c.text.length <= 600), small.map((c) => c.text.length).join(","));
check("pieces break at sentence ends", small.every((c) => c.text.endsWith(".")));
check(
  "no text is lost",
  small.map((c) => c.text).join(" ").replace(/\s+/g, " ") === longPara.replace(/\s+/g, " ")
);
check("pieces keep their heading path", small.every((c) => c.path === "Results"));
check("pieces after the first carry the paragraph's page", small.slice(1).every((c) => c.page === 2));

// A long table is split at row boundaries.
const rows = Array.from({ length: 60 }, (_, i) => [`Region ${i + 1}`, `${(i + 1) * 1000}`, `${i % 10}%`]);
const tableChunks = toChunks(doc([{ type: "table", page: 1, rows }]), 300);
check("a long table is split", tableChunks.length > 1, `${tableChunks.length} chunk(s)`);
check("table chunks fit", tableChunks.every((c) => c.text.length <= 300));
check(
  "table chunks hold whole rows",
  tableChunks.every((c) => c.text.split("\n").every((line) => /^Region \d+ \| \d+ \| \d%$/.test(line)))
);

// A single word longer than the limit is still cut to size.
const blob = toChunks(doc([para("x".repeat(1500))]), 600);
check("an unbreakable run is cut to size", blob.length === 3 && blob.every((c) => c.text.length <= 600));

// Short blocks are still packed together, separators included in the size.
// Three 99-char paragraphs plus two separators make 301, one over 300.
const packed = toChunks(doc(Array.from({ length: 10 }, (_, i) => para(`${"a".repeat(97)}${i}.`))), 300);
check(
  "short blocks are packed and fit",
  packed.length === 5 && packed.every((c) => c.text.length === 200),
  packed.map((c) => c.text.length).join(",")
);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chunk checks passed.");
