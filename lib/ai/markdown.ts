/**
 * The Markdown the assistant's answers use, as blocks to render: headings,
 * paragraphs, lists (numbered from the model's own first number, kept open
 * across blank lines, with indented items nested) and simple tables.
 * Inline formatting stays in the text for the renderer.
 */
export type MdBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; start: number; items: MdItem[] }
  | { type: "table"; head: string[]; rows: string[][] };

export interface MdItem {
  text: string;
  /** Indented lines under the item: sub-lists, more text. */
  children: MdBlock[];
}

type MdList = Extract<MdBlock, { type: "list" }>;

const ITEM = /^(\s*)(?:([-*•])|(\d{1,9})[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
/** A table's second line: |---|:--:| */
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The cells of a table row, without the outer pipes. "\|" is a pipe inside a cell. */
function cells(line: string): string[] {
  // No lookbehind: Safari before 16.4 can't parse one.
  let row = line.trim().replace(/\\\|/g, "\u0000");
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((c) => c.trim().replace(/\u0000/g, "|"));
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\t/g, "    ").split("\n").map((l) => l.trimEnd());
  const blocks: MdBlock[] = [];
  // The lists open at this point, outermost first, with their markers' indent.
  const open: { list: MdList; indent: number; into: MdBlock[] }[] = [];
  const lastItem = () => {
    const { list } = open[open.length - 1];
    return list.items[list.items.length - 1];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Blank lines don't end a list: "1. a", "", "2. b" is one list.
    if (!line.trim()) continue;
    const indent = indentOf(line);
    const item = line.match(ITEM);

    if (item) {
      const ordered = item[3] !== undefined;
      while (open.length && indent < open[open.length - 1].indent) open.pop();
      const top = open[open.length - 1];
      if (top && indent >= top.indent + 2) {
        // Indented under the item above: a sub-list.
        const into = lastItem().children;
        const list: MdList = { type: "list", ordered, start: ordered ? Number(item[3]) : 1, items: [] };
        into.push(list);
        open.push({ list, indent, into });
      } else if (!top || top.list.ordered !== ordered) {
        // A new list, or the other kind of list at the same level.
        const into = top ? top.into : blocks;
        if (top) open.pop();
        const list: MdList = { type: "list", ordered, start: ordered ? Number(item[3]) : 1, items: [] };
        into.push(list);
        open.push({ list, indent, into });
      }
      open[open.length - 1].list.items.push({ text: item[4], children: [] });
      continue;
    }

    // Any other line belongs to the deepest item it is indented under, or
    // ends the lists when it isn't indented.
    while (open.length && indent <= open[open.length - 1].indent) open.pop();
    const into = open.length ? lastItem().children : blocks;

    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && next.includes("|") && DIVIDER.test(next)) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) {
        const row = cells(lines[i]).slice(0, head.length);
        rows.push([...row, ...Array(head.length - row.length).fill("")]);
      }
      i--;
      into.push({ type: "table", head, rows });
      continue;
    }

    const heading = line.trim().match(HEADING);
    into.push(heading ? { type: "heading", text: heading[1] } : { type: "paragraph", text: line.trim() });
  }
  return blocks;
}
