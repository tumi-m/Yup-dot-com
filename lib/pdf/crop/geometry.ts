/**
 * Crop PDF's plain numbers: the box as margins cut from each edge, units,
 * which pages it goes on, the box moved by a drag or the arrow keys, and the
 * content found on a small picture of a page. No pdf-lib or React, so the
 * page loads it with the tool and tests run it as it is.
 *
 * Everything is measured on the page as the reader sees it: its visible box
 * with /Rotate applied, in points, from the top-left corner (as pdf.js lays a
 * page out at scale 1). lib/pdf/crop/index.ts turns that back into the
 * page's own space.
 */
import { parsePageList } from "../pages/plan";

/** Points cut from each edge of the page as shown. */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A box on the page as shown, from its top-left corner, in points. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Unit = "mm" | "in" | "pt";
export const UNITS: Unit[] = ["mm", "in", "pt"];
const PER_UNIT: Record<Unit, number> = { mm: 72 / 25.4, in: 72, pt: 1 };

/** The smallest box a page is cropped to: a quarter of an inch each way. */
export const MIN_SIDE = 18;

export const NO_MARGINS: Margins = { top: 0, right: 0, bottom: 0, left: 0 };
const EDGES = ["top", "right", "bottom", "left"] as const;
export type Edge = (typeof EDGES)[number];

export const toPoints = (value: number, unit: Unit) => value * PER_UNIT[unit];
export const fromPoints = (points: number, unit: Unit) => points / PER_UNIT[unit];

/** A length for a field: whole points, tenths of a millimetre, hundredths of an inch. */
export function formatLength(points: number, unit: Unit): string {
  const digits = unit === "pt" ? 0 : unit === "mm" ? 1 : 2;
  const value = fromPoints(points, unit);
  return String(Number(value.toFixed(digits)) || 0);
}

/** A typed length ("12", "12,5", " 3.2 ") in points, or null if it isn't a number of zero or more. */
export function readLength(text: string, unit: Unit): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? toPoints(n, unit) : null;
}

export function boxFromMargins(page: Size, m: Margins): Box {
  return { x: m.left, y: m.top, width: page.width - m.left - m.right, height: page.height - m.top - m.bottom };
}

export function marginsFromBox(page: Size, b: Box): Margins {
  return { top: b.y, left: b.x, right: page.width - b.x - b.width, bottom: page.height - b.y - b.height };
}

export const sameMargins = (a: Margins, b: Margins, tol = 0.01) => EDGES.every((e) => Math.abs(a[e] - b[e]) <= tol);

export const hasMargins = (m: Margins) => EDGES.some((e) => m[e] > 0.01);

/**
 * What is wrong with `m` on a page of `page`, if anything: a sentence for
 * people. The box has to keep at least MIN_SIDE each way.
 */
export function marginsProblem(page: Size, m: Margins, pageNumber?: number): string | null {
  if (EDGES.some((e) => !Number.isFinite(m[e]) || m[e] < 0)) return "Margins can't be less than 0.";
  const where = pageNumber ? ` of page ${pageNumber}` : "";
  if (page.width - m.left - m.right < MIN_SIDE - 0.01) return `The left and right margins leave almost nothing${where}. Make them smaller.`;
  if (page.height - m.top - m.bottom < MIN_SIDE - 0.01) return `The top and bottom margins leave almost nothing${where}. Make them smaller.`;
  return null;
}

/** A box kept on the page and at least MIN_SIDE each way (smaller pages: the whole page). */
export function clampBox(b: Box, page: Size): Box {
  const width = Math.min(page.width, Math.max(Math.min(MIN_SIDE, page.width), b.width));
  const height = Math.min(page.height, Math.max(Math.min(MIN_SIDE, page.height), b.height));
  return {
    x: Math.max(0, Math.min(page.width - width, b.x)),
    y: Math.max(0, Math.min(page.height - height, b.y)),
    width,
    height,
  };
}

/** Where a drag can take hold of the box: inside it, or one of its edges or corners. */
export type Grip = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const GRIPS: Exclude<Grip, "move">[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/**
 * The box after dragging `grip` by `dx`, `dy` points from where it was when
 * the drag began. Edges stop at the page and MIN_SIDE short of the opposite
 * edge; a moved box stays on the page.
 */
export function dragBox(start: Box, grip: Grip, dx: number, dy: number, page: Size): Box {
  if (grip === "move") return clampBox({ ...start, x: start.x + dx, y: start.y + dy }, page);
  const min = Math.min(MIN_SIDE, page.width, page.height);
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (grip.includes("w")) left = Math.max(0, Math.min(right - min, left + dx));
  if (grip.includes("e")) right = Math.min(page.width, Math.max(left + min, right + dx));
  if (grip.includes("n")) top = Math.max(0, Math.min(bottom - min, top + dy));
  if (grip.includes("s")) bottom = Math.min(page.height, Math.max(top + min, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A new box drawn from one point to another (either way round), kept on the page. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }, page: Size): Box {
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const x1 = Math.min(page.width, Math.max(a.x, b.x));
  const y1 = Math.min(page.height, Math.max(a.y, b.y));
  return clampBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, page);
}

const ARROWS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The keyboard version of dragging, as the editor's boxes work: arrows move
 * the box 1pt (10pt with Shift); with Alt they move its right or bottom
 * edge instead, so it grows and shrinks. Null for any other key.
 */
export function nudgeBox(b: Box, key: { key: string; shiftKey: boolean; altKey: boolean }, page: Size): Box | null {
  const dir = ARROWS[key.key];
  if (!dir) return null;
  const step = key.shiftKey ? 10 : 1;
  const [dx, dy] = [dir[0] * step, dir[1] * step];
  if (!key.altKey) return dragBox(b, "move", dx, dy, page);
  return dragBox(b, dx ? "e" : "s", dx, dy, page);
}

/** Which pages the box goes on. */
export type Scope = "all" | "current" | "odd" | "even" | "range";

/**
 * The 0-indexed pages a scope picks in a document of `count` pages: `current`
 * is the page being shown (0-indexed), `range` what was typed ("2-4, 7").
 */
export function scopePages(scope: Scope, count: number, current: number, range = ""): { pages: number[]; problem: string | null } {
  const every = (keep: (i: number) => boolean) => Array.from({ length: count }, (_, i) => i).filter(keep);
  switch (scope) {
    case "current":
      return { pages: [Math.max(0, Math.min(count - 1, current))], problem: null };
    case "odd":
      return { pages: every((i) => i % 2 === 0), problem: null };
    case "even": {
      const pages = every((i) => i % 2 === 1);
      return { pages, problem: pages.length ? null : "This PDF has only 1 page, so it has no even pages." };
    }
    case "range": {
      const { pages, problem } = parsePageList(range, count);
      return { pages, problem: problem ?? (pages.length ? null : "Type the pages to crop, like 2-4, 7.") };
    }
    default:
      return { pages: every(() => true), problem: null };
  }
}

/**
 * The part of a picture that isn't blank, in pixels from its top-left, or
 * null for a blank picture. `data` is RGBA, as a canvas gives it. A pixel
 * counts when any colour is darker than `threshold` (0..255) and it isn't
 * transparent; a row or column needs `minDots` of them, so a speck of
 * scanner dust doesn't hold the edge out.
 */
export function contentBox(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: { threshold?: number; minDots?: number } = {}
): Box | null {
  const threshold = opts.threshold ?? 245;
  const minDots = Math.max(1, opts.minDots ?? 2);
  const rows = new Uint32Array(height);
  const cols = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    let k = y * width * 4;
    for (let x = 0; x < width; x++, k += 4) {
      if (data[k + 3] > 16 && (data[k] < threshold || data[k + 1] < threshold || data[k + 2] < threshold)) {
        rows[y]++;
        cols[x]++;
      }
    }
  }
  const first = (counts: Uint32Array) => counts.findIndex((n) => n >= minDots);
  const last = (counts: Uint32Array) => {
    for (let i = counts.length - 1; i >= 0; i--) if (counts[i] >= minDots) return i;
    return -1;
  };
  const top = first(rows);
  const left = first(cols);
  if (top < 0 || left < 0) return null;
  const bottom = last(rows);
  const right = last(cols);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Margins that keep `found` (pixels of a picture drawn at `scale` pixels to
 * the point) with `padding` points round it, held to the page. Null when
 * there is nothing to cut.
 */
export function trimMargins(found: Box | null, scale: number, page: Size, padding: number): Margins | null {
  if (!found) return null;
  const box = {
    x: found.x / scale - padding,
    y: found.y / scale - padding,
    width: found.width / scale + 2 * padding,
    height: found.height / scale + 2 * padding,
  };
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(page.width, box.x + box.width);
  const y1 = Math.min(page.height, box.y + box.height);
  const kept = clampBox({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, page);
  const m = marginsFromBox(page, kept);
  // Less than a point all round isn't worth a crop.
  return EDGES.some((e) => m[e] >= 1) ? m : null;
}

/** How a box reads out: its size and where it starts. */
export function describeBox(b: Box, unit: Unit): string {
  const f = (n: number) => `${formatLength(n, unit)} ${unit}`;
  return `${formatLength(b.width, unit)} × ${f(b.height)}, ${f(b.x)} from the left, ${f(b.y)} from the top`;
}

/** The name the cropped file downloads as. */
export function croppedName(name: string): string {
  return `${name.replace(/\.pdf$/i, "") || "document"}-cropped.pdf`;
}
