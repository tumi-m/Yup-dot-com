/**
 * The word-level difference between two documents, taken over the whole
 * document rather than page by page, so text that moved to another page (a
 * paragraph added above it, a page taken out) still lines up. Runs of words
 * taken out in one place and put back in another are reported as moved.
 *
 * jsdiff's Myers diff does the work. On two long and very different files
 * it gives up after a time limit; the lines are then lined up first and the
 * words compared within the lines that differ, which is far quicker.
 */
import { diffArrays } from "diff";
import { joinWords, sameWord, type Word } from "./words";

/** `start` to one before `end`, in one document's words; empty where nothing was there. */
export interface Range {
  start: number;
  end: number;
}

export type ChangeKind = "changed" | "added" | "removed" | "moved" | "picture";

export interface Change {
  kind: ChangeKind;
  /** Words in the original: taken out, changed or moved from. Empty (where it would be) for an addition. */
  a: Range;
  /** Words in the changed version: put in, changed or moved to. Empty for a removal. */
  b: Range;
  /** The words as read, for the list and the report. */
  oldText: string;
  newText: string;
  /** Pages, 0-indexed, where it shows in each file: null where the file has no page for it. */
  oldPage: number | null;
  newPage: number | null;
  /** A picture or drawing that looks different: the areas, in displayed points. */
  areas?: { a: AreaBox[]; b: AreaBox[] };
}

export interface AreaBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WordDiff {
  changes: Change[];
  /** Words left as they were, by page pair: "pageA:pageB" → how many. */
  shared: Map<string, number>;
  /** Words lined up through their lines, after the word diff ran out of time. */
  coarse: boolean;
}

/** A run of one kind of step through both word lists. */
interface Step {
  kind: "same" | "removed" | "added";
  count: number;
}

/** Moved: at least this many words alike, so a repeated "the" or "1" isn't a move. */
const MOVE_WORDS = 3;
const MOVE_CHARS = 12;

/** How long the word diff may take before the lines are lined up first. */
export const WORD_DIFF_MS = 4000;

/** A diff of two long files that have little in common is not worth refining word by word beyond this. */
const REFINE_LIMIT = 4_000_000;

function steps<T>(a: T[], b: T[], same: (x: T, y: T) => boolean, timeout: number): Step[] | null {
  const parts = diffArrays(a, b, { comparator: same, timeout });
  if (!parts) return null;
  return parts.map((p) => ({ kind: p.added ? "added" : p.removed ? "removed" : "same", count: p.count }));
}

/** Lines of words, for lining up whole lines first. */
function linesOf(words: Word[]): { key: string; start: number; end: number }[] {
  const out: { key: string; start: number; end: number }[] = [];
  words.forEach((w, i) => {
    const last = out[out.length - 1];
    if (last && words[last.start].line === w.line) {
      last.key += ` ${w.key.replace(/-/g, "")}`;
      last.end = i + 1;
    } else {
      out.push({ key: w.key.replace(/-/g, ""), start: i, end: i + 1 });
    }
  });
  return out;
}

/**
 * Lines lined up first, then the words within each run of lines that
 * differ: a word added in a paragraph rewraps every line after it, and
 * those lines then line up word by word.
 */
function coarseSteps(a: Word[], b: Word[], timeout: number): Step[] {
  const la = linesOf(a);
  const lb = linesOf(b);
  const lineSteps = steps(la, lb, (x, y) => x.key === y.key, timeout) ?? [
    { kind: "removed", count: la.length },
    { kind: "added", count: lb.length },
  ];
  const out: Step[] = [];
  const add = (kind: Step["kind"], count: number) => {
    if (!count) return;
    const last = out[out.length - 1];
    if (last?.kind === kind) last.count += count;
    else out.push({ kind, count });
  };
  let i = 0;
  let j = 0;
  for (let k = 0; k < lineSteps.length; k++) {
    const s = lineSteps[k];
    if (s.kind === "same") {
      const words = la[i + s.count - 1].end - la[i].start;
      add("same", words);
      i += s.count;
      j += s.count;
      continue;
    }
    // A run of differing lines on both sides, refined word by word.
    let removed = 0;
    let added = 0;
    while (k < lineSteps.length && lineSteps[k].kind !== "same") {
      if (lineSteps[k].kind === "removed") removed += lineSteps[k].count;
      else added += lineSteps[k].count;
      k++;
    }
    k--;
    const wa = removed ? a.slice(la[i].start, la[i + removed - 1].end) : [];
    const wb = added ? b.slice(lb[j].start, lb[j + added - 1].end) : [];
    const inner = wa.length && wb.length && wa.length * wb.length <= REFINE_LIMIT ? steps(wa, wb, sameWord, timeout) : null;
    if (inner) for (const st of inner) add(st.kind, st.count);
    else {
      add("removed", wa.length);
      add("added", wb.length);
    }
    i += removed;
    j += added;
  }
  return out;
}

/** The page a range shows on: its first word's, or the word it would come before. */
export function pageAt(words: Word[], r: Range): number | null {
  if (!words.length) return null;
  if (r.start < r.end) return words[r.start].page;
  return words[Math.min(r.start, words.length - 1)].page;
}

const keyOf = (words: Word[], r: Range) => words.slice(r.start, r.end).map((w) => w.key.replace(/-/g, "")).join(" ");

/** What changed between the words of the original (`a`) and the changed version (`b`). */
export function diffWords(a: Word[], b: Word[], opts: { timeout?: number } = {}): WordDiff {
  const timeout = opts.timeout ?? WORD_DIFF_MS;
  let coarse = false;
  let path = steps(a, b, sameWord, timeout);
  if (!path) {
    coarse = true;
    path = coarseSteps(a, b, timeout);
  }

  const shared = new Map<string, number>();
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < path.length) {
    const s = path[k];
    if (s.kind === "same") {
      for (let n = 0; n < s.count; n++) {
        const key = `${a[i + n].page}:${b[j + n].page}`;
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
      i += s.count;
      j += s.count;
      k++;
      continue;
    }
    // Removals and additions next to each other are one change.
    const ra: Range = { start: i, end: i };
    const rb: Range = { start: j, end: j };
    while (k < path.length && path[k].kind !== "same") {
      if (path[k].kind === "removed") ra.end = i += path[k].count;
      else rb.end = j += path[k].count;
      k++;
    }
    const kind = ra.start === ra.end ? "added" : rb.start === rb.end ? "removed" : "changed";
    changes.push({
      kind,
      a: ra,
      b: rb,
      oldText: joinWords(a.slice(ra.start, ra.end)),
      newText: joinWords(b.slice(rb.start, rb.end)),
      oldPage: pageAt(a, ra),
      newPage: pageAt(b, rb),
    });
  }
  return { changes: findMoves(changes, a, b), shared, coarse };
}

/**
 * A run taken out in one place and the same run put in elsewhere is a move:
 * one change, kept where it was in the original, that says where it went.
 */
function findMoves(changes: Change[], a: Word[], b: Word[]): Change[] {
  const added = new Map<string, number[]>();
  changes.forEach((c, n) => {
    if (c.kind !== "added") return;
    const key = keyOf(b, c.b);
    added.set(key, [...(added.get(key) ?? []), n]);
  });
  const gone = new Set<number>();
  for (const c of changes) {
    if (c.kind !== "removed" || c.a.end - c.a.start < MOVE_WORDS) continue;
    const key = keyOf(a, c.a);
    if (key.length < MOVE_CHARS) continue;
    const match = added.get(key)?.find((n) => !gone.has(n));
    if (match === undefined) continue;
    gone.add(match);
    const to = changes[match];
    c.kind = "moved";
    c.b = to.b;
    c.newText = to.newText;
    c.newPage = to.newPage;
  }
  return changes.filter((_, n) => !gone.has(n));
}
