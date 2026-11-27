import { CATEGORY_LABELS, type ToolCategory, type ToolMeta } from "@/lib/tools";

/** Category filters. "Optimize" holds a single tool, so it folds into Organize. */
export type ToolGroup = Exclude<ToolCategory, "optimize">;
export type ToolPill = ToolGroup | "all";

export const TOOL_GROUPS: ToolGroup[] = ["organize", "convert", "slides", "extract", "security", "edit", "media"];
export const TOOL_PILLS: ToolPill[] = ["all", ...TOOL_GROUPS];

export function groupOf(category: ToolCategory): ToolGroup {
  return category === "optimize" ? "organize" : category;
}

export function pillLabel(pill: ToolPill): string {
  return pill === "all" ? "All" : CATEGORY_LABELS[pill];
}

/** Reads a `?c=` value; anything unknown means all tools. */
export function parsePill(value: string | null | undefined): ToolPill {
  if (value === "optimize") return "organize";
  return TOOL_PILLS.includes(value as ToolPill) ? (value as ToolPill) : "all";
}

/** Words a search can leave out: "merge pdf online free" means "merge pdf". */
const FILLER = new Set(["to", "a", "the", "and", "online", "free"]);

/**
 * Lowercase words, one trailing "s" off, so "pdfs" finds "PDF" and "covers"
 * "cover". "PDF/A" (or "pdf a") is one word ("pdfa"): split, its "a" would
 * be dropped as a filler word.
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\bpdf\s*[/-]?\s*a(?![\p{L}\p{N}])/gu, "pdfa")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** Every query word starts some word of the text, in any order. */
function matchesAll(query: string[], text: string[]): boolean {
  return query.every((q) => text.some((w) => w.startsWith(q)));
}

/** Same, with the query words found in the text's order ("ppt to pdf" is PPTX to PDF, not PDF to PPTX). */
function matchesInOrder(query: string[], text: string[]): boolean {
  let from = 0;
  for (const q of query) {
    const at = text.findIndex((w, i) => i >= from && w.startsWith(q));
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}

/**
 * Tools in a category whose words cover the search. Tools named by the search
 * (by their name or another name they go by) come first, in its word order
 * before any order: "text to pdf" is TXT to PDF before PDF to Text. Then
 * tools going the search's way (into PDF or out of it), then those whose
 * title has its words in its order, then those matching whole words ("log"
 * before "logo"), each as listed.
 */
export function filterTools(tools: ToolMeta[], pill: ToolPill, query: string): ToolMeta[] {
  const q = words(query).filter((w) => !FILLER.has(w));
  const inPill = tools.filter((t) => pill === "all" || groupOf(t.category) === pill);
  if (!q.length) return inPill;
  const into = q.length > 1 && q.at(-1) === "pdf";
  const out = q.length > 1 && q[0] === "pdf";
  const ranked: { tool: ToolMeta; rank: number; toward: number; titled: number; whole: number }[] = [];
  for (const t of inPill) {
    // Fields kept apart, so a title's last "PDF" and a description's first "A" don't read as "PDF A".
    const text = [t.name, t.title, t.description, CATEGORY_LABELS[t.category], CATEGORY_LABELS[groupOf(t.category)], t.keywords ?? ""].flatMap(words);
    const name = words(t.name);
    const aliases = (t.aliases ?? []).map(words);
    if (!matchesAll(q, [...text, ...aliases.flat()])) continue;
    // Another name counts only in the search's order: "pdf to image" isn't Image to PDF.
    const rank = matchesInOrder(q, name) || aliases.some((a) => matchesInOrder(q, a)) ? 0 : matchesAll(q, name) ? 1 : 2;
    // "png to pdf" wants a tool into PDF, "pdf to png" one out of it.
    const toward = (into && name.at(-1) === "pdf") || (out && name[0] === "pdf") ? 1 : 0;
    const titled = matchesInOrder(q, words(t.title)) ? 1 : 0;
    const whole = q.filter((w) => text.includes(w)).length;
    ranked.push({ tool: t, rank, toward, titled, whole });
  }
  // Array sort is stable, so each rank keeps the catalogue's order.
  return ranked.sort((a, b) => a.rank - b.rank || b.toward - a.toward || b.titled - a.titled || b.whole - a.whole).map((r) => r.tool);
}

/** Roving focus in a radio group: arrows wrap, Home and End jump. */
export function rovingIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
