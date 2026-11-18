/**
 * Where each change shows on the pages: a box per line of changed words
 * (and per changed area of a picture), on the original or the changed
 * version. The page view draws these, and the marked PDFs carry them as
 * highlight, strike-out and underline annotations.
 */
import type { Change, ChangeKind } from "./diff";
import type { Box, Word } from "./words";

export type { Side } from "./view";
import type { Side } from "./view";

/**
 * What a mark shows: words taken out, put in, moved, a picture that looks
 * different, or the spot in one file where the other has words this one hasn't.
 */
export type MarkKind = "removed" | "added" | "moved" | "picture" | "gap";

export interface Mark {
  kind: MarkKind;
  /** The change it belongs to, in the list. */
  change: number;
  /** 0-indexed. */
  page: number;
  box: Box;
}

/** How a change shows on each side. */
const SHOWS: Record<ChangeKind, Record<Side, MarkKind | null>> = {
  changed: { a: "removed", b: "added" },
  added: { a: null, b: "added" },
  removed: { a: "removed", b: null },
  moved: { a: "moved", b: "moved" },
  picture: { a: "picture", b: "picture" },
};

/** Each change's marks on one side, a box per line (a word broken over a line end gives two). */
export function marksFor(side: Side, changes: Change[], words: Word[]): Mark[] {
  const out: Mark[] = [];
  changes.forEach((c, n) => {
    const kind = SHOWS[c.kind][side];
    if (!kind) {
      const gap = gapBox(words, side === "a" ? c.a.start : c.b.start);
      if (gap) out.push({ kind: "gap", change: n, ...gap });
      return;
    }
    if (c.kind === "picture") {
      const page = side === "a" ? c.oldPage : c.newPage;
      if (page === null) return;
      for (const box of c.areas?.[side] ?? []) out.push({ kind, change: n, page, box });
      return;
    }
    const range = side === "a" ? c.a : c.b;
    let open: (Mark & { line: number }) | null = null;
    for (let i = range.start; i < range.end; i++) {
      const w = words[i];
      w.boxes.forEach((box, k) => {
        // The second box of a broken word is on the next line.
        const line = w.line + k;
        if (open && open.line === line && open.page === w.page && k === 0) {
          const right = Math.max(open.box.x + open.box.width, box.x + box.width);
          const bottom = Math.max(open.box.y + open.box.height, box.y + box.height);
          open.box.x = Math.min(open.box.x, box.x);
          open.box.y = Math.min(open.box.y, box.y);
          open.box.width = right - open.box.x;
          open.box.height = bottom - open.box.y;
          return;
        }
        if (open) out.push(strip(open));
        open = { kind, change: n, page: w.page, box: { ...box }, line };
      });
    }
    if (open) out.push(strip(open));
  });
  return out;
}

/** A thin box where words would be: before the word at `at`, or after the last word before it. */
function gapBox(words: Word[], at: number): { page: number; box: Box } | null {
  const next = words[at];
  if (next) {
    const b = next.boxes[0];
    return { page: next.page, box: { x: b.x - 1.5, y: b.y, width: 2, height: b.height } };
  }
  const prev = words[at - 1];
  if (!prev) return null;
  const b = prev.boxes[prev.boxes.length - 1];
  return { page: prev.page, box: { x: b.x + b.width - 0.5, y: b.y, width: 2, height: b.height } };
}

const strip = ({ line: _line, ...mark }: Mark & { line: number }): Mark => mark;

/** Marks by page, for drawing one page at a time. */
export function marksByPage(marks: Mark[]): Map<number, Mark[]> {
  const out = new Map<number, Mark[]>();
  for (const m of marks) {
    const list = out.get(m.page);
    if (list) list.push(m);
    else out.set(m.page, [m]);
  }
  return out;
}
