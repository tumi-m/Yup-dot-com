// Chat with PDF answers: a blank line between list items, or a sub-bullet
// under one, used to close the list, so every item showed as "1.". The
// number the model wrote was dropped, and tables showed as raw pipes.
import { parseMarkdown, type MdBlock } from "../lib/ai/markdown.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const lists = (blocks: MdBlock[]) => blocks.filter((b) => b.type === "list");

// A loose list: blank lines between the items.
{
  const md = parseMarkdown("Steps:\n\n1. Open the form (p. 1)\n\n2. Sign page 3 (p. 3)\n\n3. Return it by Friday (p. 4)\n");
  const ls = lists(md);
  check("loose list is one list", ls.length === 1, md);
  const l = ls[0];
  check("with all three items, numbered from 1",
    l?.type === "list" && l.ordered && l.start === 1 && l.items.map((i) => i.text).join("|") === "Open the form (p. 1)|Sign page 3 (p. 3)|Return it by Friday (p. 4)", l);
  check("the lead-in stays a paragraph", md[0].type === "paragraph" && md[0].text === "Steps:");
}

// Sub-bullets under numbered items.
{
  const md = parseMarkdown(
    "Action items:\n\n1. **Approve the budget** (p. 2)\n   - Owner: Finance\n   - Due: 30 June\n2. **Hire two engineers** (p. 4)\n   - Owner: HR\n3. **Renew the lease** (p. 7)\n"
  );
  const ls = lists(md);
  check("nested list is one numbered list at the top", ls.length === 1 && ls[0].type === "list" && ls[0].ordered, md);
  const l = ls[0].type === "list" ? ls[0] : null;
  check("three numbered items", l?.items.length === 3 && l.items[2].text === "**Renew the lease** (p. 7)", l);
  const sub = l?.items[0].children[0];
  check("sub-bullets sit inside their item",
    sub?.type === "list" && !sub.ordered && sub.items.map((i) => i.text).join("|") === "Owner: Finance|Due: 30 June", l?.items[0]);
  const sub2 = l?.items[1].children[0];
  check("each item keeps its own sub-bullets", sub2?.type === "list" && sub2.items.length === 1 && sub2.items[0].text === "Owner: HR");
  check("the last item has none", l?.items[2].children.length === 0);
}

// The model's numbers are kept when a list starts later.
{
  const md = parseMarkdown("1. First\n\nA note between.\n\n2. Second\n3. Third");
  const ls = lists(md);
  check("a list split by a paragraph keeps counting",
    ls.length === 2 && ls[1].type === "list" && ls[1].start === 2 && ls[1].items.length === 2, md);
  check("the note is a paragraph between them", md[1].type === "paragraph" && md[1].text === "A note between.");
}

// Indented text under an item stays with it.
{
  const md = parseMarkdown("1. Budget\n   Owner: Finance\n2. Hiring");
  const l = lists(md)[0];
  check("continuation line stays in its item",
    md.length === 1 && l.type === "list" && l.items.length === 2 && l.items[0].children[0]?.type === "paragraph", md);
}

// Bullets and numbers at the same level are separate lists; unindented text ends a list.
{
  const md = parseMarkdown("- a\n- b\n1. c\nAfter.");
  check("switching kind starts a new list", md.length === 3 && md[0].type === "list" && !md[0].ordered && md[1].type === "list" && md[1].ordered);
  check("unindented text ends the list", md[2].type === "paragraph" && md[2].text === "After.");
}

// Tables.
{
  const md = parseMarkdown("Key dates:\n\n| Date | Event |\n|---|---|\n| 1 May | Launch (p. 3) |\n| 9 June | Review (p. 5) |\n\nThat's all.");
  const t = md.find((b) => b.type === "table");
  check("a table is a table", t?.type === "table" && t.head.join("|") === "Date|Event" &&
    JSON.stringify(t.rows) === JSON.stringify([["1 May", "Launch (p. 3)"], ["9 June", "Review (p. 5)"]]), md);
  check("no divider or pipes left as text", !md.some((b) => (b.type === "paragraph" || b.type === "heading") && b.text.includes("|")), md);
  check("text after the table is a paragraph", md.at(-1)?.type === "paragraph");
  const ragged = parseMarkdown("a | b | c\n:-- | :-: | --:\n1 | 2\n4 | 5 | 6 | 7\n| x \\| y | z | w |");
  const r = ragged[0];
  check("tables without outer pipes, short and long rows, escaped pipes",
    r?.type === "table" && r.head.length === 3 &&
      JSON.stringify(r.rows) === JSON.stringify([["1", "2", ""], ["4", "5", "6"], ["x | y", "z", "w"]]), ragged);
  check("a line with a pipe but no divider is text", parseMarkdown("Revenue | up 5%\nNext line")[0].type === "paragraph");
  check("a dash underline is not a table", parseMarkdown("Title | x\n---")[0].type === "paragraph");
}

// Headings, bold and plain answers as before.
{
  const md = parseMarkdown("## Summary\nThe report is **short**.\n\n* one\n* two");
  check("heading, paragraph, bullets", md[0].type === "heading" && md[0].text === "Summary" &&
    md[1].type === "paragraph" && md[2].type === "list" && !md[2].ordered && md[2].items.length === 2, md);
  check("bold at the start of a line is not a bullet", parseMarkdown("**Total:** R 12 000")[0].type === "paragraph");
  check("empty answer, no blocks", parseMarkdown("").length === 0);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Markdown checks passed.");
