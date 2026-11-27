/**
 * Edit text in the editor: turning a run into an edit, placing it on screen,
 * the page colour round it, moving between runs with the keys, and what to
 * tell people. Kept free of React so it can be unit tested.
 */
import type { CoverReason, EditableRun, LockReason } from "@/lib/pdf/edit-text/types";
import type { TextEditReport } from "@/lib/pdf/edit-text/apply";
import type { TextEditAnnotation } from "./types";

/** A new edit of `run`, its words and style as they are, on page `page` (0-indexed). */
export function editFromRun(run: EditableRun, page: number, background: string, id: string): TextEditAnnotation {
  return {
    id,
    type: "edit",
    page,
    ...run.box,
    run,
    text: run.text,
    fontSize: Math.round(run.size * 100) / 100,
    color: run.color,
    bold: run.font.bold,
    italic: run.font.italic,
    background,
  };
}

/**
 * CSS transform from run space to the page layer at `scale`, for an element
 * whose own coordinates run along the line (x) and down from the baseline (y),
 * `k` times larger than points (so small text can be typed at 16px or more
 * without phones zooming in). `origin` is where the element's parent sits on
 * the page, in points.
 */
export function runTransform(run: EditableRun, scale: number, k = 1, origin = { x: 0, y: 0 }): string {
  const [a, b, c, d, e, f] = run.display;
  const s = scale / k;
  const n = (v: number) => Math.round(v * 10000) / 10000;
  return `matrix(${n(a * s)}, ${n(b * s)}, ${n(-c * s)}, ${n(-d * s)}, ${n((e - origin.x) * scale)}, ${n((f - origin.y) * scale)})`;
}

/**
 * The page's colour round a run: the commonest colour on the border of the
 * picture `rgba` (width × height, four bytes a pixel) of the area just
 * outside it. Close colours count as one (anti-aliasing, JPEG noise).
 */
export function ringColor(rgba: ArrayLike<number>, width: number, height: number): string {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const alpha = rgba[i + 3] / 255;
    // The canvas is see-through where nothing is drawn: that is white paper.
    const r = rgba[i] * alpha + 255 * (1 - alpha);
    const g = rgba[i + 1] * alpha + 255 * (1 - alpha);
    const b = rgba[i + 2] * alpha + 255 * (1 - alpha);
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  };
  if (width < 1 || height < 1) return "#ffffff";
  for (let x = 0; x < width; x++) {
    add(x, 0);
    if (height > 1) add(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    add(0, y);
    if (width > 1) add(width - 1, y);
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  if (!best) return "#ffffff";
  const hex = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, "0");
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

/** Which run a key moves to among `count` runs from `index`: the next or previous, the first or last. Null for other keys. */
export function runStep(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowDown" || key === "ArrowRight") return Math.min(count - 1, index + 1);
  if (key === "ArrowUp" || key === "ArrowLeft") return Math.max(0, index - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** Why a run can't be changed here, for people. */
export const LOCKED: Record<LockReason, string> = {
  rtl: "Right-to-left text (Arabic, Hebrew) can't be changed here yet.",
  vertical: "Text written top to bottom can't be changed here yet.",
};

/** Why a run's old words can only be covered, for people. */
export const COVERED: Record<CoverReason | "page", string> = {
  shared: "the page draws them together with other text",
  form: "they are part of a block the page reuses",
  type3: "their font is made of drawings",
  hidden: "they are the hidden text over a scan",
  clip: "the page cuts part of them off",
  unmatched: "they couldn't be matched to how the page draws them",
  page: "the page couldn't be read safely",
};

/** Whether an edit changes nothing yet: same words, size, colour and style as the run. */
export function pristine(e: TextEditAnnotation): boolean {
  const r = e.run;
  return e.text === r.text && Math.abs(e.fontSize - r.size) < 0.01 && e.color.toLowerCase() === r.color.toLowerCase() && e.bold === r.font.bold && e.italic === r.font.italic;
}

const list = (pages: number[]) => {
  const p = [...new Set(pages)].sort((a, b) => a - b);
  return p.length === 1 ? `page ${p[0]}` : `pages ${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
};

/** What to tell people after a save or download changed text, if anything: covered words, other fonts, letters left out. */
export function textNotice(report: TextEditReport): { covered: string | null; fonts: string[]; missing: string | null } {
  const n = report.covered.length;
  const covered = n
    ? `The old words of ${n === 1 ? "1 changed line" : `${n} changed lines`} on ${list(report.covered.map((c) => c.page))} are covered, not removed: they are still in the file under a box.`
    : null;
  const byChange = new Map<string, number[]>();
  for (const f of report.fonts) {
    const key = `${f.to}\u0000${f.from}`;
    byChange.set(key, [...(byChange.get(key) ?? []), f.page]);
  }
  const fonts = [...byChange].map(([key, pages]) => {
    const [to, from] = key.split("\u0000");
    return `New words on ${list(pages)} use ${to} instead of ${from}.`;
  });
  const missing = report.missing.length ? `Some letters can't be drawn here and were left out: ${report.missing.slice(0, 8).join(" ")}.` : null;
  return { covered, fonts, missing };
}
