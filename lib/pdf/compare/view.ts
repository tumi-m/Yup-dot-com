/**
 * The Compare PDFs page's plain logic, kept apart from React so it can be
 * tested: where dropped files go, the names of the downloads, which pages a
 * change is shown on, and what is read out for it.
 */
import type { Change, CompareResult, PagePair } from "./index";

export type Side = "a" | "b";

export const KIND_LABEL: Record<Change["kind"], string> = {
  changed: "Changed",
  added: "Added",
  removed: "Removed",
  moved: "Moved",
  picture: "Looks different",
};

export const SIDE_LABEL: Record<Side, string> = { a: "Original", b: "Changed version" };

export const other = (side: Side): Side => (side === "a" ? "b" : "a");

/**
 * Where picked or dropped PDFs go: the first to the side it was dropped on,
 * a second to the other side. More than two: the rest are left out.
 */
export function placeFiles<F>(files: F[], side: Side): { side: Side; file: F }[] {
  return files.slice(0, 2).map((file, i) => ({ side: i === 0 ? side : other(side), file }));
}

const stem = (name: string) => name.replace(/\.pdf$/i, "").trim() || "document";

/** The names the downloads are saved as, like the other tools' ("-cropped.pdf"). Two files with one name are told apart. */
export function exportNames(a: string, b: string): { report: string; markedA: string; markedB: string } {
  let sa = stem(a);
  let sb = stem(b);
  if (sa === sb) {
    sa = `${sa}-original`;
    sb = `${sb}-changed`;
  }
  return { report: `${stem(b)}-comparison.pdf`, markedA: `${sa}-marked.pdf`, markedB: `${sb}-marked.pdf` };
}

/** The row of the side-by-side view a change is shown in. */
export function pairOfChange(c: Change, pairs: PagePair[]): number {
  const inB = c.newPage === null ? -1 : pairs.findIndex((p) => p.b === c.newPage);
  const inA = c.oldPage === null ? -1 : pairs.findIndex((p) => p.a === c.oldPage);
  // A removal is seen in the original, an addition or a move's new place in the changed version.
  const first = c.kind === "removed" ? [inA, inB] : [inB, inA];
  return first.find((n) => n >= 0) ?? 0;
}

/** One step through the changes, staying at the ends. -1: none picked yet. */
export function stepChange(current: number, total: number, by: 1 | -1): number {
  if (!total) return -1;
  if (current < 0) return by > 0 ? 0 : total - 1;
  return Math.max(0, Math.min(total - 1, current + by));
}

const short = (text: string, max = 80) => {
  const t = [...text];
  return t.length > max ? `${t.slice(0, max).join("")}…` : text;
};

/** What is read out when a change is picked. */
export function describeChange(c: Change, index: number, total: number): string {
  const page = (n: number | null, file: string) => (n === null ? "" : `page ${n + 1} of the ${file}`);
  const head = `Change ${index + 1} of ${total}, ${KIND_LABEL[c.kind].toLowerCase()}`;
  switch (c.kind) {
    case "changed":
      return `${head}: “${short(c.oldText)}” became “${short(c.newText)}”, ${page(c.newPage, "changed version")}.`;
    case "added":
      return `${head}: “${short(c.newText)}”, ${page(c.newPage, "changed version")}.`;
    case "removed":
      return `${head}: “${short(c.oldText)}”, ${page(c.oldPage, "original")}.`;
    case "moved":
      return `${head}: “${short(c.oldText)}”, from ${page(c.oldPage, "original")} to ${page(c.newPage, "changed version")}.`;
    case "picture":
      return `${head}: ${page(c.oldPage, "original")} and ${page(c.newPage, "changed version")}.`;
  }
}

/** True when the files read and look the same. */
export function identical(r: CompareResult): boolean {
  return !r.changes.length && !r.summary.pagesAdded.length && !r.summary.pagesRemoved.length;
}

/** "Pages 2 and 5" of a file, people's numbering. */
export function pagesText(pages: number[]): string {
  const n = pages.map((p) => String(p + 1));
  if (n.length === 1) return `page ${n[0]}`;
  return `pages ${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}
