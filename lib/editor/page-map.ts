import type { Annotation } from "./types";

/** Where a page ends up after a page operation: its new index, or null when it is gone. */
export type PageMap = (oldIndex: number) => number | null;

/** Reorder: `order[k]` is the old index of the page now at k. */
export function orderMap(order: number[]): PageMap {
  const at = new Map(order.map((old, k) => [old, k]));
  return (i) => at.get(i) ?? null;
}

/** Delete page `t`: the pages after it move up one. */
export const deleteMap =
  (t: number): PageMap =>
  (i) =>
    i < t ? i : i === t ? null : i - 1;

/** A page inserted after page `t`: the pages after it move down one. */
export const insertAfterMap =
  (t: number): PageMap =>
  (i) =>
    i > t ? i + 1 : i;

/** Merge adds pages at the end, so every page keeps its index. */
export const sameMap: PageMap = (i) => i;

/**
 * Annotations moved with their pages. Those on a page that is gone go with
 * it, as do links to a page that is gone (the page operation drops those
 * from the file too).
 */
export function remapAnnotations(anns: Annotation[], map: PageMap): Annotation[] {
  const out: Annotation[] = [];
  let changed = false;
  for (const a of anns) {
    const page = map(a.page);
    const target = a.type === "link" && a.targetPage !== null ? map(a.targetPage) : undefined;
    if (page === null || target === null) {
      changed = true;
      continue;
    }
    if (page === a.page && (target === undefined || (a.type === "link" && target === a.targetPage))) {
      out.push(a);
      continue;
    }
    changed = true;
    out.push(target === undefined ? { ...a, page } : { ...(a as Extract<Annotation, { type: "link" }>), page, targetPage: target });
  }
  // The same array when nothing moved, so history sees no change.
  return changed ? out : anns;
}

/** The page to show after an operation: the same page where it went, or the nearest one left. */
export function pageAfter(current: number, map: PageMap, numPages: number): number {
  const next = map(current);
  return Math.max(0, Math.min(next ?? current, numPages - 1));
}
