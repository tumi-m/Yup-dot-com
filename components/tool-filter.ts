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

export function filterTools(tools: ToolMeta[], pill: ToolPill, query: string): ToolMeta[] {
  const q = query.trim().toLowerCase();
  return tools.filter(
    (t) =>
      (pill === "all" || groupOf(t.category) === pill) &&
      (!q || `${t.name} ${t.title} ${t.description} ${CATEGORY_LABELS[t.category]}`.toLowerCase().includes(q))
  );
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
