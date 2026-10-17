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

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll chunk checks passed.");
