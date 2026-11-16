/**
 * The page list behind Organize PDF, Delete pages and Extract pages: which
 * pages go into the new file, in what order and turned how far. Changing it
 * is instant and costs nothing, so undo is cheap; the PDF itself is only
 * written once, when the person saves (see ./index.ts). Kept free of pdf-lib
 * and React so it can be unit tested and loads with the page.
 */

export type PagesMode = "organize" | "delete" | "extract";

/** A page of one of the chosen files (`source` 0 is the first file). */
export interface SourcePage {
  id: string;
  kind: "page";
  source: number;
  /** 0-indexed page in its file. */
  page: number;
  /** Turned this far clockwise on top of the page's own rotation: 0, 90, 180 or 270. */
  rotate: number;
}

/** A blank page added in between, of the size the page before it is shown at. */
export interface BlankPage {
  id: string;
  kind: "blank";
  width: number;
  height: number;
  rotate: number;
}

export type PlanItem = SourcePage | BlankPage;

const pageId = (source: number, page: number) => `${source}:${page}`;
let blanks = 0;

/** Every page of a file, in order. */
export function planFor(source: number, pageCount: number): PlanItem[] {
  return Array.from({ length: pageCount }, (_, page) => ({ id: pageId(source, page), kind: "page", source, page, rotate: 0 }));
}

/** Another file's pages, added at the end. */
export function appendSource(plan: PlanItem[], source: number, pageCount: number): PlanItem[] {
  return [...plan, ...planFor(source, pageCount)];
}

/**
 * Moves the `ids` pages together so the first of them lands at `to` in the
 * result, keeping their order. Pages picked apart are gathered into one run.
 */
export function moveItems(plan: PlanItem[], ids: ReadonlySet<string>, to: number): PlanItem[] {
  const moving = plan.filter((p) => ids.has(p.id));
  if (!moving.length) return plan;
  const rest = plan.filter((p) => !ids.has(p.id));
  const at = Math.max(0, Math.min(to, rest.length));
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  return next.every((p, i) => p === plan[i]) ? plan : next;
}

/** Turns the `ids` pages by `delta` degrees (a multiple of 90; negative turns left). */
export function rotateItems(plan: PlanItem[], ids: ReadonlySet<string>, delta: number): PlanItem[] {
  if (!plan.some((p) => ids.has(p.id))) return plan;
  return plan.map((p) => (ids.has(p.id) ? { ...p, rotate: (((p.rotate + delta) % 360) + 360) % 360 } : p));
}

export function removeItems(plan: PlanItem[], ids: ReadonlySet<string>): PlanItem[] {
  const next = plan.filter((p) => !ids.has(p.id));
  return next.length === plan.length ? plan : next;
}

/** A blank page of `size` after position `after` (-1 puts it first). */
export function insertBlank(plan: PlanItem[], after: number, size: { width: number; height: number }): { plan: PlanItem[]; id: string } {
  const id = `blank-${++blanks}`;
  const at = Math.max(0, Math.min(after + 1, plan.length));
  const blank: BlankPage = { id, kind: "blank", width: size.width, height: size.height, rotate: 0 };
  return { plan: [...plan.slice(0, at), blank, ...plan.slice(at)], id };
}

/**
 * Reverses the order. With two or more pages picked, only those swap places
 * among themselves; the rest stay where they are.
 */
export function reverseItems(plan: PlanItem[], ids?: ReadonlySet<string>): PlanItem[] {
  if (plan.length < 2) return plan;
  const picked = ids && plan.filter((p) => ids.has(p.id)).length >= 2 ? ids : null;
  if (!picked) return [...plan].reverse();
  const reversed = plan.filter((p) => picked.has(p.id)).reverse();
  let k = 0;
  return plan.map((p) => (picked.has(p.id) ? reversed[k++] : p));
}

/** The ids from `from` to `to` (either way round), for Shift-click. */
export function idsBetween(plan: PlanItem[], from: string, to: string): string[] {
  const a = plan.findIndex((p) => p.id === from);
  const b = plan.findIndex((p) => p.id === to);
  if (a < 0 || b < 0) return b < 0 ? [] : [to];
  return plan.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id);
}

/** Whether the plan writes the first file back as it was. */
export function unchanged(plan: PlanItem[], pageCount: number): boolean {
  return plan.length === pageCount && plan.every((p, i) => p.kind === "page" && p.source === 0 && p.page === i && p.rotate === 0);
}

/**
 * Reads "2-4, 7" as 0-indexed pages, sorted and each once. Spaces work as
 * well as commas, "8-" runs to the last page and "-3" from the first.
 * Anything that isn't a page of the document is named in `problem`, so a
 * typo never quietly picks the wrong pages.
 */
export function parsePageList(input: string, pageCount: number): { pages: number[]; problem: string | null } {
  const picked = new Set<number>();
  const bad: string[] = [];
  let outside = false;
  // "2 - 4" is one range, so spaces around a dash go first.
  for (const token of input.replace(/\s*[-–]\s*/g, "-").split(/[,;\s]+/)) {
    if (!token) continue;
    const m = token.match(/^(\d*)-(\d*)$/);
    const single = /^\d+$/.test(token) ? Number(token) : null;
    if (!m && single === null) {
      bad.push(token);
      continue;
    }
    let a = single ?? (m![1] ? Number(m![1]) : 1);
    let b = single ?? (m![2] ? Number(m![2]) : pageCount);
    if (m && !m[1] && !m[2]) {
      bad.push(token);
      continue;
    }
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > pageCount) outside = true;
    for (let n = Math.max(1, a); n <= Math.min(b, pageCount); n++) picked.add(n - 1);
  }
  const pages = [...picked].sort((x, y) => x - y);
  const problem = bad.length
    ? `"${bad[0]}" isn't a page number. Try something like 2-4, 7.`
    : outside
      ? pageCount === 1
        ? "This PDF has only 1 page."
        : `Pages go from 1 to ${pageCount}.`
      : null;
  return { pages, problem };
}

/** 0-indexed pages written the way people type them: "2-4, 7". */
export function pageListText(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j === i ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j + 1;
  }
  return parts.join(", ");
}

/** The name the new file downloads as. */
export function resultName(name: string, mode: PagesMode, pages: number[] = []): string {
  const base = name.replace(/\.pdf$/i, "") || "document";
  if (mode === "organize") return `${base}-organized.pdf`;
  if (mode === "delete") return `${base}-trimmed.pdf`;
  const sorted = [...pages].sort((a, b) => a - b);
  const run = sorted.length > 0 && sorted.every((p, i) => p === sorted[0] + i);
  if (!run) return `${base}-extracted.pdf`;
  const first = sorted[0] + 1;
  const last = sorted[sorted.length - 1] + 1;
  return first === last ? `${base}-page-${first}.pdf` : `${base}-pages-${first}-${last}.pdf`;
}
