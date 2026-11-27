// Prints "More tools" and search results as JSON for the switches set in the
// environment (which lib/tools.tsx reads once, as it loads), so a test can
// compare them with Word, Excel and HTML to PDF on and off.
const { relatedTools, TOOLS } = await import("../../lib/tools.tsx");
const { filterTools } = await import("../../components/tool-filter.ts");
const slugs = ["pdf-to-word", "pdf-to-excel", "pptx-to-pdf", "compress-pdf", "repair-pdf", "markdown-to-pdf", "pdf-to-pdfa"];
const queries = ["excel", "csv to pdf", "pdf a", "PDF/A", "word"];
console.log(
  JSON.stringify({
    shown: TOOLS.map((t) => t.slug),
    related: Object.fromEntries(slugs.map((s) => [s, relatedTools(s).map((t) => t.slug)])),
    search: Object.fromEntries(queries.map((q) => [q, filterTools(TOOLS, "all", q).map((t) => t.slug)])),
  })
);
