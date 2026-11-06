/**
 * Tabs, counts and the "years apart" facts for a song's connections. No
 * catalog here, so the page can use these without downloading it.
 */
import type { Relation, Role, Tab, TabCounts } from "./types";

export const ROLE_ORDER: Role[] = ["samples", "sampledBy", "covers", "coveredBy", "remixOf", "remixedBy"];

export const TAB_ROLES: Record<Tab, Role[]> = {
  samples: ["samples"],
  sampled: ["sampledBy"],
  covers: ["covers", "coveredBy"],
  remixes: ["remixOf", "remixedBy"],
};

export const TABS: Tab[] = ["samples", "sampled", "covers", "remixes"];

export function tabOf(role: Role): Tab {
  return TABS.find((t) => TAB_ROLES[t].includes(role))!;
}

export function tabCounts(relations: Relation[]): TabCounts {
  const counts: TabCounts = { samples: 0, sampled: 0, covers: 0, remixes: 0 };
  for (const r of relations) counts[tabOf(r.role)]++;
  return counts;
}

/** The first tab with something in it, or "samples". */
export function firstTab(counts: TabCounts): Tab {
  return TABS.find((t) => counts[t] > 0) ?? "samples";
}

/** Years between two songs, only when both are known. */
export function yearsApart(a: number | null | undefined, b: number | null | undefined): number | null {
  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b);
}

/** The oldest record a song samples: its year and how much earlier it is. */
export function oldestSample(relations: Relation[], songYear: number | null): { year: number; apart: number | null } | null {
  const years = relations.filter((r) => r.role === "samples" && typeof r.year === "number").map((r) => r.year as number);
  if (!years.length) return null;
  const year = Math.min(...years);
  return { year, apart: yearsApart(songYear, year) };
}

/** How often a song was sampled, and over which years. */
export function sampledSpan(relations: Relation[]): { count: number; from: number | null; to: number | null } {
  const rows = relations.filter((r) => r.role === "sampledBy");
  const years = rows.filter((r) => typeof r.year === "number").map((r) => r.year as number);
  return { count: rows.length, from: years.length ? Math.min(...years) : null, to: years.length ? Math.max(...years) : null };
}
