import type { PDFPageProxy } from "pdfjs-dist";
import { pageText, type Glyph, type Paint, type ShowOp } from "../redact/page-text";
import type { TextRun } from "../redact/marks";
import { hasRtl } from "../parse";
import { WATERMARK_TEXT } from "../../edit-usage";
import type { CoverReason, EditableRun, Family, Matrix, Point, RemovePlan, RunFont } from "./types";

/**
 * A page's text as Edit text offers it: pdf.js's text items, with each
 * letter placed from the page's drawing operations (the reader Redact PDF
 * uses), grouped into runs of one line in one font, size and colour. Each
 * run says where it is, how it is drawn, and which operations of the page's
 * own content draw it, when only it is drawn by them. Text hidden under a
 * cover Edit text drew, and the free plan's "Made with PDF Wizard" mark, are
 * left out. Takes any pdf.js page, so Node tests can use pdf.js's legacy
 * build.
 */

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

interface FontObj {
  name?: string;
  bold?: boolean;
  black?: boolean;
  italic?: boolean;
  isType3Font?: boolean;
  fallbackName?: string;
  type?: string;
  subtype?: string;
  missingFile?: boolean;
  ascent?: number;
  descent?: number;
}

const SERIF = /times|serif|roman|georgia|garamond|cambria|palatino|book ?antiqua|baskerville|minion|caslon|century|didot|bodoni|charter|constantia|libertine|tinos|merriweather|lora|playfair|cmr\d|lmroman|nimbusrom/i;
const MONO = /courier|mono|consol|menlo|inconsolata|lucida ?console|cmtt|lmmono|nimbusmon|code/i;

/** The kind of letters a font draws, from its name and what pdf.js read of its flags. */
export function familyOf(name: string, fallback?: string): Family {
  const plain = name.replace(/^[A-Z]{6}\+/, "");
  if (fallback === "monospace" || MONO.test(plain)) return "mono";
  if (fallback === "serif" || SERIF.test(plain)) return "serif";
  return "sans";
}

function runFont(obj: FontObj | null): RunFont {
  const name = obj?.name ?? "";
  const plain = name.replace(/^[A-Z]{6}\+/, "");
  return {
    name,
    family: familyOf(name, obj?.fallbackName),
    bold: !!obj?.bold || !!obj?.black || /bold|black|heavy|semibold|demibold|extrabold/i.test(plain),
    italic: !!obj?.italic || /italic|oblique|slanted/i.test(plain),
    subset: /^[A-Z]{6}\+/.test(name),
    type3: !!obj?.isType3Font,
    program: !obj?.missingFile && (obj?.type === "TrueType" || obj?.type === "CIDFontType2" || obj?.subtype === "OpenType"),
  };
}

/** One item read with its frame: run space at its own start, and where it reaches. */
interface Piece {
  run: TextRun;
  /** Run space (normalised text matrix) to user space; null when the item has no size. */
  user: Matrix;
  size: number;
  color: string | null;
  blank: boolean;
}

const clean = (s: string) => s.replace(/[\u0000-\u001f]/g, "");

export interface ReadOptions {
  /** pdf.js's OPS and AnnotationMode.DISABLE. */
  ops: Record<string, number>;
  noAnnotations: number;
}

/** The page's editable runs, in the order the page draws them. */
export async function editableRuns(page: PDFPageProxy, opts: ReadOptions): Promise<EditableRun[]> {
  const vp = page.getViewport({ scale: 1 });
  const view = [...vp.transform] as Matrix;
  const glyphs: Glyph[] = [];
  const shows: ShowOp[] = [];
  const paints: Paint[] = [];
  const text = await pageText(page, { exact: { ops: opts.ops, noAnnotations: opts.noAnnotations, glyphs, shows, paints } });
  const fonts = new Map<string, FontObj | null>();
  const font = (name: string | undefined): FontObj | null => {
    if (!name) return null;
    if (!fonts.has(name)) {
      try {
        fonts.set(name, page.commonObjs.get(name) as FontObj);
      } catch {
        fonts.set(name, null);
      }
    }
    return fonts.get(name) ?? null;
  };
  // Each operation's place among those of the page's own content.
  const level: number[] = [];
  let own = 0;
  for (const s of shows) level.push(s.form ? -1 : own++);

  const fromView = invert(view);
  const pieces: Piece[] = [];
  for (const run of text.runs.flatMap((r) => (fromView ? byColour(r, glyphs, shows, fromView) : [r]))) {
    const m = run.matrix as Matrix | undefined;
    if (!m) continue;
    const size = Math.hypot(m[2], m[3]);
    if (!(size > 0) || !(Math.hypot(m[0], m[1]) > 0)) continue;
    const user: Matrix = [m[0] / size, m[1] / size, m[2] / size, m[3] / size, m[4], m[5]];
    let color: string | null = null;
    if (run.glyphs) {
      for (let g = run.glyphs[0]; g < run.glyphs[1]; g++) {
        if (!glyphs[g].text.trim()) continue;
        color = colourOf(shows[glyphs[g].op]);
        break;
      }
    }
    pieces.push({ run, user, size, color, blank: !run.str.trim() });
  }

  // Group items into runs: one line, one font, size and colour, no wide gap.
  const groups: Piece[][] = [];
  let current: Piece[] = [];
  let reach = 0;
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
  };
  for (const p of pieces) {
    // pdf.js fills a gap with a blank item: a word space is passed over, a wider one ends the run.
    if (p.blank) {
      if (current.length && (p.run.width ?? 0) > current[0].size * 0.6) flush();
      continue;
    }
    const head = current[0];
    if (head) {
      const inv = invert(head.user);
      const [x, y] = inv ? apply(inv, p.user[4], p.user[5]) : [NaN, NaN];
      const along = head.user[0] * p.user[0] + head.user[1] * p.user[1];
      const same =
        p.run.font === head.run.font &&
        Math.abs(p.size - head.size) <= head.size * 0.05 &&
        p.color === head.color &&
        along > 0.999 * Math.hypot(head.user[0], head.user[1]) * Math.hypot(p.user[0], p.user[1]) &&
        Math.abs(y) <= head.size * 0.2 &&
        x >= reach - head.size * 0.5 &&
        x - reach <= head.size &&
        !current[current.length - 1].run.eol;
      if (!same) flush();
    }
    current.push(p);
    reach = Math.max(current.length === 1 ? 0 : reach, endOf(current[0], p));
  }
  flush();

  const out: EditableRun[] = [];
  /** The last operation that draws each run (null when its letters weren't lined up with any). */
  const lastOp: (number | null)[] = [];
  for (const group of groups) {
    const head = group[0];
    const inv = invert(head.user);
    if (!inv) continue;
    const display = mul(view, head.user);
    const toRun = invert(display);
    // The text, with a space where two items stand apart.
    let str = "";
    let end = 0;
    group.forEach((p, i) => {
      const [x] = apply(inv, p.user[4], p.user[5]);
      const piece = clean(p.run.str);
      if (i && x - end > head.size * 0.15 && !/\s$/.test(str) && !/^\s/.test(piece)) str += " ";
      str += piece;
      end = Math.max(end, endOf(head, p));
    });
    str = str.replace(/\s+/g, " ").trim();
    if (!str) continue;

    // Where its letters are along the line: from the drawn glyphs, or the items' widths.
    let x0 = 0;
    let x1 = end;
    const exact = group.every((p) => p.run.glyphs);
    if (exact && toRun) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of group) {
        for (let g = p.run.glyphs![0]; g < p.run.glyphs![1]; g++) {
          for (const pt of [glyphs[g].a, glyphs[g].b]) {
            const [x] = apply(toRun, pt[0], pt[1]);
            lo = Math.min(lo, x);
            hi = Math.max(hi, x);
          }
        }
      }
      if (Number.isFinite(lo) && hi > lo) [x0, x1] = [Math.min(0, lo), hi];
    }
    const f = font(head.run.font);
    const ascent = clamp(f?.ascent, 0.6, 1.2, 0.85);
    const descent = clamp(f?.descent, -0.45, -0.1, -0.22);
    const s = head.size;
    const quad: [Point, Point, Point, Point] = [
      apply(display, x0, descent * s),
      apply(display, x1, descent * s),
      apply(display, x1, ascent * s),
      apply(display, x0, ascent * s),
    ];
    const xs = quad.map((q) => q[0]);
    const ys = quad.map((q) => q[1]);
    const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    const rf = runFont(f);
    const locked = group.some((p) => p.run.vertical) ? "vertical" : group.some((p) => p.run.rtl) || hasRtl(str) ? "rtl" : null;

    let remove: RemovePlan | null = null;
    let cover: CoverReason | null = null;
    if (!exact) cover = "unmatched";
    else {
      const verdict = plan(group, glyphs, shows, level, own, box, rf);
      if ("cover" in verdict) cover = verdict.cover;
      else remove = verdict;
    }
    const first = head.run.glyphs ? head.run.glyphs[0] : -1 - pieces.indexOf(head);
    let last: number | null = null;
    if (exact) for (const p of group) for (let g = p.run.glyphs![0]; g < p.run.glyphs![1]; g++) last = Math.max(last ?? -1, glyphs[g].op);
    lastOp.push(last);
    out.push({
      key: `${first}:${str}`,
      text: str,
      display,
      user: head.user,
      size: s,
      x0,
      x1,
      ascent,
      descent,
      quad,
      box,
      font: rf,
      color: head.color ?? "#000000",
      locked,
      remove,
      cover,
    });
  }
  return inPageOrder(settle(out, lastOp, paints));
}

const areaOf = (b: EditableRun["box"]) => Math.max(0, b.width) * Math.max(0, b.height);
/** How much of `a` lies inside `b` (a page box from the top left, or a Rect). */
function sharedArea(a: EditableRun["box"], b: EditableRun["box"] | { x0: number; y0: number; x1: number; y1: number }): number {
  const [bx0, by0, bx1, by1] = "x0" in b ? [b.x0, b.y0, b.x1, b.y1] : [b.x, b.y, b.x + b.width, b.y + b.height];
  const w = Math.min(a.x + a.width, bx1) - Math.max(a.x, bx0);
  const h = Math.min(a.y + a.height, by1) - Math.max(a.y, by0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * What else on the page bears on each run. A cover Edit text drew over it
 * hides it: it isn't offered again. A picture or opaque shape painted over
 * it, or other text in the same place, means taking out its operators
 * wouldn't take away what shows there: it can only be covered. A second
 * copy of the same words in the same place (bold made by drawing twice, a
 * shadow) is one run: both copies go, or both are covered.
 */
function settle(runs: EditableRun[], last: (number | null)[], paints: Paint[]): EditableRun[] {
  const keep = runs.map((r) => r.text !== WATERMARK_TEXT);
  const overlap = (r: EditableRun) => {
    r.remove = null;
    r.cover ??= "overlap";
  };
  runs.forEach((run, i) => {
    const area = areaOf(run.box);
    if (!keep[i] || !area) return;
    for (const p of paints) {
      // Painted before the run, it is under it. A run's order is unknown when its letters weren't lined up: covers are always drawn after the page's own text.
      if (last[i] !== null ? p.after <= last[i]! : p.kind !== "cover") continue;
      const share = sharedArea(run.box, p.box) / area;
      if (p.kind === "cover" && share >= 0.7) {
        keep[i] = false;
        return;
      }
      if (p.kind !== "cover" && share >= 0.3) overlap(run);
    }
  });
  const order = runs.map((_, i) => i).filter((i) => keep[i]).sort((a, b) => runs[a].box.y - runs[b].box.y);
  for (let n = 0; n < order.length; n++) {
    const i = order[n];
    for (let m = n + 1; m < order.length && keep[i]; m++) {
      const j = order[m];
      if (runs[j].box.y > runs[i].box.y + runs[i].box.height) break;
      if (!keep[j]) continue;
      const share = sharedArea(runs[i].box, runs[j].box) / Math.max(1e-6, Math.min(areaOf(runs[i].box), areaOf(runs[j].box)));
      if (share < 0.5) continue;
      if (runs[i].text !== runs[j].text) {
        overlap(runs[i]);
        overlap(runs[j]);
        continue;
      }
      // The copy drawn last is the one on top: it stands for both.
      const [top, under] = (last[j] ?? -1) >= (last[i] ?? -1) ? [j, i] : [i, j];
      merge(runs[top], runs[under]);
      keep[under] = false;
    }
  }
  return runs.filter((_, i) => keep[i]);
}

/** Folds a second copy of a run's words into it: its operators go too, and the run's box reaches over it. */
function merge(top: EditableRun, under: EditableRun) {
  if (top.remove && under.remove && top.remove.total === under.remove.total) {
    const ops = new Map([...top.remove.ops, ...under.remove.ops].map((o) => [o.index, o]));
    top.remove = { total: top.remove.total, ops: [...ops.values()].sort((a, b) => a.index - b.index) };
  } else {
    // One copy can't be taken out: both are covered, for its reason.
    top.cover = top.remove ? (under.cover ?? "overlap") : (top.cover ?? "overlap");
    top.remove = null;
  }
  const toRun = invert(top.display);
  if (!toRun) return;
  for (const [x, y] of under.quad.map((q) => apply(toRun, q[0], q[1]))) {
    top.x0 = Math.min(top.x0, x);
    top.x1 = Math.max(top.x1, x);
    top.ascent = Math.max(top.ascent, y / top.size);
    top.descent = Math.min(top.descent, y / top.size);
  }
  const s = top.size;
  top.quad = [apply(top.display, top.x0, top.descent * s), apply(top.display, top.x1, top.descent * s), apply(top.display, top.x1, top.ascent * s), apply(top.display, top.x0, top.ascent * s)];
  const xs = top.quad.map((q) => q[0]);
  const ys = top.quad.map((q) => q[1]);
  top.box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/**
 * Runs in reading order on the page as shown: line by line down the page
 * (as most of its text runs), each line from its start. The page's drawing
 * order isn't kept: words a save draws again come last in it.
 */
function inPageOrder(runs: EditableRun[]): EditableRun[] {
  if (runs.length < 2) return runs;
  // The way most of the text runs.
  const ways = new Map<string, { n: number; m: Matrix }>();
  for (const r of runs) {
    const key = `${Math.round(Math.atan2(r.display[1], r.display[0]) / (Math.PI / 2))}`;
    const e = ways.get(key) ?? { n: 0, m: r.display };
    e.n++;
    ways.set(key, e);
  }
  const m = [...ways.values()].sort((a, b) => b.n - a.n)[0].m;
  const along = Math.hypot(m[0], m[1]) || 1;
  const up = Math.hypot(m[2], m[3]) || 1;
  const placed = runs.map((r) => ({ r, line: -(r.display[4] * m[2] + r.display[5] * m[3]) / up, at: (r.display[4] * m[0] + r.display[5] * m[1]) / along }));
  placed.sort((a, b) => a.line - b.line);
  const lines: (typeof placed)[] = [];
  for (const p of placed) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(p.line - line[0].line) < Math.min(p.r.size, line[0].r.size) * 0.5) line.push(p);
    else lines.push([p]);
  }
  return lines.flatMap((line) => line.sort((a, b) => a.at - b.at).map((p) => p.r));
}

const colourOf = (s: ShowOp) => (s.mode === 1 || s.mode === 5 ? s.stroke : s.fill) ?? "#000000";

/**
 * pdf.js keeps text in one item across a change of colour: split it there,
 * so each part is a run of one colour. Each part starts where its first
 * letter is drawn and ends where its last one does.
 */
function byColour(run: TextRun, glyphs: Glyph[], shows: ShowOp[], fromView: Matrix): TextRun[] {
  const units = run.units;
  const m = run.matrix;
  if (!units || !run.glyphs || !m) return [run];
  // Spaces go with the letters before them.
  const parts: { from: number; to: number; colour: string | null }[] = [];
  units.forEach((gi, i) => {
    const colour = gi < 0 || !glyphs[gi].text.trim() ? null : colourOf(shows[glyphs[gi].op]);
    const last = parts[parts.length - 1];
    if (!last || (colour && last.colour && colour !== last.colour)) parts.push({ from: i, to: i + 1, colour });
    else {
      last.to = i + 1;
      last.colour ??= colour;
    }
  });
  if (parts.length < 2) return [run];
  const len = Math.hypot(m[0], m[1]) || 1;
  return parts.map((part, k) => {
    const mine = units.slice(part.from, part.to).filter((gi) => gi >= 0);
    const first = glyphs[Math.min(...mine)];
    const lastGlyph = glyphs[Math.max(...mine)];
    const [ax, ay] = apply(fromView, first.a[0], first.a[1]);
    const [bx, by] = apply(fromView, lastGlyph.b[0], lastGlyph.b[1]);
    return {
      ...run,
      str: run.str.slice(part.from, part.to),
      matrix: [m[0], m[1], m[2], m[3], ax, ay],
      width: ((bx - ax) * m[0] + (by - ay) * m[1]) / len,
      glyphs: [Math.min(...mine), Math.max(...mine) + 1],
      units: units.slice(part.from, part.to),
      spans: run.spans?.slice(part.from, part.to),
      eol: k === parts.length - 1 && run.eol,
    };
  });
}

const clamp = (v: number | undefined, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;

/** How far along `head`'s line the item `p` reaches, in `head`'s run space. */
function endOf(head: Piece, p: Piece): number {
  const inv = invert(head.user);
  if (!inv) return 0;
  const m = p.run.matrix!;
  const len = Math.hypot(m[0], m[1]) || 1;
  const width = Math.max(0, p.run.width ?? 0);
  const [x] = apply(inv, m[4] + (m[0] / len) * width, m[5] + (m[1] / len) * width);
  return x;
}

/**
 * Which of the page's own operations to take out for a run, or why it can
 * only be covered. Each operation must draw nothing outside the run but
 * spaces, from the page's own content, in a font of outlines, visibly and
 * not clipped short.
 */
function plan(group: Piece[], glyphs: Glyph[], shows: ShowOp[], level: number[], total: number, box: EditableRun["box"], font: RunFont): RemovePlan | { cover: CoverReason } {
  if (font.type3) return { cover: "type3" };
  const mine = new Set<number>();
  for (const p of group) for (let g = p.run.glyphs![0]; g < p.run.glyphs![1]; g++) mine.add(g);
  // A space between two runs may be drawn by the next run's operation: it doesn't make that one this run's.
  const ops = [...new Set([...mine].filter((g) => glyphs[g].text.trim()).map((g) => glyphs[g].op))].sort((a, b) => a - b);
  if (!ops.length) return { cover: "unmatched" };
  for (const k of ops) {
    const s = shows[k];
    if (s.form || level[k] < 0) return { cover: "form" };
    if (s.mode === 3 || s.mode === 7 || s.alpha < 0.01) return { cover: "hidden" };
    if (s.mode > 3) return { cover: "clip" };
    if (s.clip === "complex") return { cover: "clip" };
    if (s.clip && (s.clip.x0 > box.x + 1 || s.clip.y0 > box.y + 1 || s.clip.x1 < box.x + box.width - 1 || s.clip.y1 < box.y + box.height - 1)) return { cover: "clip" };
    // Every code it draws has a glyph, so it draws only what the list shows.
    if (s.count !== s.codes.length) return { cover: "unmatched" };
    for (let g = s.first; g < s.first + s.count; g++) {
      if (!mine.has(g) && (glyphs[g].text.trim() || !glyphs[g].space && glyphs[g].text === "")) return { cover: "shared" };
    }
  }
  return { total, ops: ops.map((k) => ({ index: level[k], codes: shows[k].codes, advance: shows[k].advance, size: shows[k].size })) };
}
