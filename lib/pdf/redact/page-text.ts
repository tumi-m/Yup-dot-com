import type { PDFPageProxy } from "pdfjs-dist";
import type { Flow, NoteText, PageText, Rect, TextRun } from "./marks";
import { COVER_TAG } from "../edit-text/types";

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];

export interface PageTextOptions {
  /**
   * The same page from a copy of the file with its boxes made very large:
   * pdf.js leaves out text outside the visible area, and that copy shows it.
   * Runs wholly outside the page go in `hidden`.
   */
  wide?: PDFPageProxy;
  /**
   * Place each letter where the font puts it, from the page's drawing
   * operations (pdf.js's OPS, and its AnnotationMode.DISABLE). `glyphs`,
   * `shows` and `paints`, when given, are filled with the letters, the
   * operations that drew them and what else was painted after them, for
   * callers that need to know which operation drew what and what hides it.
   */
  exact?: { ops: Record<string, number>; noAnnotations: number; glyphs?: Glyph[]; shows?: ShowOp[]; paints?: Paint[] };
}

/**
 * A page's text as Redact PDF marks and checks it: each run pdf.js reads,
 * boxed in displayed points from the top-left with the way its letters go,
 * and the text its comments, links and form fields hold. Takes any pdf.js
 * page, so Node tests can use pdf.js's legacy build.
 */
export async function pageText(page: PDFPageProxy, opts: PageTextOptions = {}): Promise<PageText> {
  const vp = page.getViewport({ scale: 1 });
  const content = await (opts.wide ?? page).getTextContent();
  const runs: TextRun[] = [];
  const hidden: TextRun[] = [];
  const view: Rect = { x0: 0, y0: 0, x1: vp.width, y1: vp.height };
  let last: TextRun | undefined;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    if (!item.str) {
      if (item.hasEOL && last) last.eol = true;
      continue;
    }
    const [a, b, c, d, e, f] = item.transform as number[];
    const style = content.styles[item.fontName];
    const len = Math.hypot(a, b) || 1;
    // Vertical fonts advance down the page; pdf.js gives their length as the height.
    const vertical = !!style?.vertical;
    const advance = vertical ? item.height : item.width;
    const dx = vertical ? 0 : (a / len) * advance;
    const dy = vertical ? -advance : (b / len) * advance;
    // From a quarter of the font size below the baseline (descenders) to a full one above, as ownText does.
    const corners = vertical
      ? [
          [e - len / 2, f],
          [e + len / 2, f],
          [e - len / 2, f + dy],
          [e + len / 2, f + dy],
        ].map(([x, y]) => vp.convertToViewportPoint(x, y))
      : [
          [e - c / 4, f - d / 4],
          [e + c, f + d],
        ].flatMap(([x, y]) => [vp.convertToViewportPoint(x, y), vp.convertToViewportPoint(x + dx, y + dy)]);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const rect: Rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const [sx, sy] = vp.convertToViewportPoint(e, f);
    const [tx, ty] = vp.convertToViewportPoint(e + dx, f + dy);
    let flow = flowOf(tx - sx, ty - sy);
    // pdf.js gives right-to-left text in reading order: its first letter is on the right.
    if (item.dir === "rtl" && flow === "right") flow = "left";
    last = {
      str: item.str,
      rect,
      flow,
      eol: !!item.hasEOL,
      mono: style?.fontFamily === "monospace",
      font: item.fontName,
      matrix: [a, b, c, d, e, f],
      width: advance,
      ...(item.dir === "rtl" ? { rtl: true } : {}),
      ...(vertical ? { vertical: true } : {}),
    };
    // Text the page doesn't show at all; text partly on it stays with the rest, and is painted where it shows.
    const outside = !!opts.wide && !(rect.x0 < view.x1 && rect.x1 > view.x0 && rect.y0 < view.y1 && rect.y1 > view.y0);
    (outside ? hidden : runs).push(last);
  }

  const notes: NoteText[] = [];
  for (const a of (await page.getAnnotations()) as Record<string, unknown>[]) {
    const texts = noteTexts(a);
    const r = a.rect as number[] | undefined;
    if (!texts.length || !r) continue;
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(r);
    const rect = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    for (const text of texts) notes.push({ text, rect });
  }
  const out: PageText = { runs, notes, size: { width: vp.width, height: vp.height } };
  if (opts.wide) out.hidden = hidden;
  if (opts.exact) {
    const list = await page.getOperatorList({ annotationMode: opts.exact.noAnnotations });
    const fonts = (name: string) => {
      try {
        return page.commonObjs.get(name) as FontInfo;
      } catch {
        return null;
      }
    };
    const glyphs = glyphsOf(list.fnArray, list.argsArray, opts.exact.ops, fonts, vp.transform as Matrix, { shows: opts.exact.shows, paints: opts.exact.paints });
    placeLetters(runs, glyphs);
    if (opts.exact.glyphs) for (const g of glyphs) opts.exact.glyphs.push(g);
    out.exact = true;
  }
  return out;
}

function flowOf(dx: number, dy: number): Flow {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return "right";
  if (Math.abs(dy) <= Math.abs(dx) * 0.05) return dx > 0 ? "right" : "left";
  if (Math.abs(dx) <= Math.abs(dy) * 0.05) return dy > 0 ? "down" : "up";
  return "angled";
}

// --- Where each letter is ----------------------------------------------------------

interface FontInfo {
  fontMatrix?: number[];
  vertical?: boolean;
}

/** A drawn letter's text, and where its advance starts and ends on the page as shown. */
export interface Glyph {
  text: string;
  a: Point;
  b: Point;
  /** The text-showing operation that drew it: its place among all of them, in drawing order. */
  op: number;
  /** Its character code as the file stores it. */
  code: number;
  /** The font says it is a space. */
  space: boolean;
}

/** One text-showing operation (Tj, TJ, ' or ") as pdf.js draws it. */
export interface ShowOp {
  /** Drawn by a form XObject the page uses, not by the page's own content. */
  form: boolean;
  /** pdf.js's name for its font (look it up in the page's commonObjs). */
  font: string;
  /** The font size (without its sign). */
  size: number;
  /** How far it moves the text along the line, in text space units before horizontal scaling. */
  advance: number;
  /** The character codes it draws, in order. */
  codes: number[];
  /** Its glyphs in the list: from `first`, `count` of them. */
  first: number;
  count: number;
  /** Text rendering mode (Tr): 3 is invisible, 4 and up add the text to the clipping path. */
  mode: number;
  /** How opaque it is drawn (the graphics state's ca, or CA for outlined text): 0 shows nothing. */
  alpha: number;
  /** Fill and stroke colours as #rrggbb, or null for a pattern. */
  fill: string | null;
  stroke: string | null;
  /** The clipping in force, on the page as shown: none, a box, or a shape that isn't a box. */
  clip: Rect | "complex" | null;
}

/**
 * Something painted that can hide text drawn before it: a picture, an
 * opaque filled shape, or a cover Edit text drew over old words. `after`
 * says how many text-showing operations came before it.
 */
export interface Paint {
  kind: "image" | "fill" | "cover";
  box: Rect;
  after: number;
}

const hexColor = (c: ArrayLike<number> | undefined) =>
  c && c.length >= 3 ? `#${[c[0], c[1], c[2]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, "0")).join("")}` : null;

/** The box a clip path makes on the page as shown, when it is one upright rectangle. */
function clipBox(path: { rects: boolean; box: number[] | null }, m: Matrix): Rect | "complex" {
  if (!path.rects || !path.box) return "complex";
  const [x0, y0, x1, y1] = path.box;
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
  // Turned by anything but quarter turns, the box isn't upright on the page.
  const upright = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 || Math.abs(m[0]) < 1e-6 && Math.abs(m[3]) < 1e-6;
  if (!upright) return "complex";
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function intersect(a: Rect | "complex" | null, b: Rect | "complex"): Rect | "complex" {
  if (a === "complex" || b === "complex") return "complex";
  if (!a) return b;
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

const mul = (m: Matrix, n: number[]): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Every letter the page draws, in drawing order, placed as pdf.js's canvas
 * places it: the font's own advance widths with character and word spacing,
 * horizontal scaling, rise and the kerning in TJ arrays. Vertical fonts are
 * left out: their runs keep the estimate. `shows`, when given, gets every
 * text-showing operation, vertical ones too, so its places count them all.
 */
export function glyphsOf(
  fnArray: number[],
  argsArray: unknown[][],
  OPS: Record<string, number>,
  fonts: (name: string) => FontInfo | null,
  view: Matrix,
  sinks: { shows?: ShowOp[]; paints?: Paint[] } = {}
): Glyph[] {
  const { shows, paints } = sinks;
  const fresh = () => ({
    ctm: IDENTITY,
    tm: IDENTITY,
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
    tc: 0,
    tw: 0,
    tz: 1,
    leading: 0,
    rise: 0,
    size: 0,
    dir: 1,
    fm: [0.001, 0, 0, 0.001, 0, 0],
    vertical: false,
    font: "",
    mode: 0,
    fill: "#000000" as string | null,
    stroke: "#000000" as string | null,
    clip: null as Rect | "complex" | null,
    forms: 0,
    fillAlpha: 1,
    strokeAlpha: 1,
  });
  let s = fresh();
  const stack: (typeof s)[] = [];
  const out: Glyph[] = [];
  let op = 0;
  /** The path being built, for a clip: whether it is only rectangles, and its bounds. */
  let path = { rects: true, box: null as number[] | null };
  let clipping = false;
  /** Marked content open, innermost last: whether each is a cover Edit text drew. */
  const marks: boolean[] = [];
  const box = (m: Matrix, x0: number, y0: number, x1: number, y1: number): Rect => {
    const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x1, y1), apply(m, x0, y1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const setFont = (name: unknown, size: unknown) => {
    const font = typeof name === "string" ? fonts(name) : null;
    const n = Number(size) || 0;
    s.dir = n < 0 ? -1 : 1;
    s.size = Math.abs(n);
    s.fm = font?.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    s.vertical = !!font?.vertical;
    s.font = typeof name === "string" ? name : "";
  };
  const ends = new Set([OPS.endPath, OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const moveText = (x: number, y: number) => {
    s.x = s.lineX += x;
    s.y = s.lineY += y;
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] ?? [];
    if (ends.has(fn)) {
      // An opaque fill can hide text drawn before it.
      if (paints && fills.has(fn) && path.box && s.fillAlpha >= 0.99) {
        paints.push({ kind: marks.includes(true) ? "cover" : "fill", box: box(mul(view, s.ctm), path.box[0], path.box[1], path.box[2], path.box[3]), after: op });
      }
      // A clip takes effect when its path is finished.
      if (clipping) s.clip = intersect(s.clip, clipBox(path, mul(view, s.ctm)));
      clipping = false;
      path = { rects: true, box: null };
    }
    switch (fn) {
      case OPS.save:
        stack.push({ ...s });
        break;
      case OPS.restore:
        s = stack.pop() ?? s;
        break;
      case OPS.transform:
        s.ctm = mul(s.ctm, args as number[]);
        break;
      case OPS.constructPath: {
        const [kinds, , minMax] = args as [number[] | undefined, unknown, number[] | undefined];
        // One rectangle per constructPath: a second one, or curves, make a shape.
        if (path.box || !kinds || kinds.length !== 1 || kinds[0] !== OPS.rectangle) path.rects = false;
        const b = minMax && minMax.length === 4 && minMax.every(Number.isFinite) ? minMax : null;
        path.box = b && path.box ? [Math.min(path.box[0], b[0]), Math.min(path.box[1], b[1]), Math.max(path.box[2], b[2]), Math.max(path.box[3], b[3])] : b ? [...b] : null;
        break;
      }
      case OPS.beginMarkedContent:
      case OPS.beginMarkedContentProps: {
        const tag = args[0] as string | { name?: string } | undefined;
        marks.push((typeof tag === "string" ? tag : tag?.name) === COVER_TAG);
        break;
      }
      case OPS.endMarkedContent:
        marks.pop();
        break;
      case OPS.setGState:
        for (const [key, value] of (args[0] ?? []) as [string, unknown][]) {
          if (key === "ca" && typeof value === "number") s.fillAlpha = value;
          if (key === "CA" && typeof value === "number") s.strokeAlpha = value;
          if (key === "Font" && Array.isArray(value)) setFont(value[0], value[1]);
        }
        break;
      case OPS.clip:
      case OPS.eoClip:
        clipping = true;
        break;
      case OPS.setTextRenderingMode:
        s.mode = Number(args[0]) || 0;
        break;
      case OPS.setFillRGBColor:
        s.fill = hexColor(args as ArrayLike<number>);
        break;
      case OPS.setStrokeRGBColor:
        s.stroke = hexColor(args as ArrayLike<number>);
        break;
      case OPS.setFillColorN:
        s.fill = null;
        break;
      case OPS.setStrokeColorN:
        s.stroke = null;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject:
        // Pictures are drawn into the unit square.
        paints?.push({ kind: "image", box: box(mul(view, s.ctm), 0, 0, 1, 1), after: op });
        break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...s });
        s.forms++;
        if (Array.isArray(args[0]) && args[0].length === 6) s.ctm = mul(s.ctm, args[0] as number[]);
        break;
      case OPS.paintFormXObjectEnd:
        s = stack.pop() ?? s;
        break;
      case OPS.beginText:
        s.tm = IDENTITY;
        s.x = s.y = s.lineX = s.lineY = 0;
        break;
      case OPS.setTextMatrix: {
        const m = (Array.isArray(args[0]) ? args[0] : args) as number[];
        s.tm = [m[0], m[1], m[2], m[3], m[4], m[5]];
        s.x = s.y = s.lineX = s.lineY = 0;
        break;
      }
      case OPS.moveText:
        moveText(Number(args[0]) || 0, Number(args[1]) || 0);
        break;
      case OPS.setLeadingMoveText:
        s.leading = -(Number(args[1]) || 0);
        moveText(Number(args[0]) || 0, Number(args[1]) || 0);
        break;
      case OPS.nextLine:
        moveText(0, s.leading);
        break;
      case OPS.setLeading:
        s.leading = -(Number(args[0]) || 0);
        break;
      case OPS.setCharSpacing:
        s.tc = Number(args[0]) || 0;
        break;
      case OPS.setWordSpacing:
        s.tw = Number(args[0]) || 0;
        break;
      case OPS.setHScale:
        s.tz = (Number(args[0]) || 0) / 100;
        break;
      case OPS.setTextRise:
        s.rise = Number(args[0]) || 0;
        break;
      case OPS.setFont:
        setFont(args[0], args[1]);
        break;

      case OPS.showText: {
        const hs = s.tz * s.dir;
        const items = (args[0] ?? []) as (number | { unicode?: string; width?: number; isSpace?: boolean; originalCharCode?: number })[];
        const show: ShowOp = {
          form: s.forms > 0,
          font: s.font,
          size: s.size,
          advance: 0,
          codes: [],
          first: out.length,
          count: 0,
          mode: s.mode,
          alpha: s.mode === 1 || s.mode === 5 ? s.strokeAlpha : s.fillAlpha,
          fill: s.fill,
          stroke: s.stroke,
          clip: s.clip,
        };
        for (const g of items) if (typeof g !== "number") show.codes.push(Number(g.originalCharCode) || 0);
        shows?.push(show);
        const n = op++;
        if (!s.size || s.vertical) break;
        const m = mul(mul(view, s.ctm), s.tm);
        const at = (x: number) => apply(m, s.x + x * hs, s.y + s.rise);
        let x = 0;
        for (const g of items) {
          if (typeof g === "number") {
            x -= (g * s.size) / 1000;
            continue;
          }
          const w = (Number(g.width) || 0) * s.fm[0] * s.size;
          out.push({ text: g.unicode ?? "", a: at(x), b: at(x + w), op: n, code: Number(g.originalCharCode) || 0, space: !!g.isSpace });
          x += w + ((g.isSpace ? s.tw : 0) + s.tc) * s.dir;
        }
        show.count = out.length - show.first;
        show.advance = x;
        s.x += x * hs;
        break;
      }
    }
  }
  return out;
}

/** How far to look ahead for a run's letters: pdf.js leaves some out (text off the page). */
const LOOK_AHEAD = 4000;
const space = (c: string) => /\s/.test(c);

/**
 * Gives each run the place of each of its letters along the line, from the
 * drawn letters. Runs come in drawing order, as the letters do; a run whose
 * letters can't be lined up with them keeps the estimate.
 */
export function placeLetters(runs: TextRun[], glyphs: Glyph[]) {
  // One entry per UTF-16 unit, as runs are counted: a ligature's letters share its width.
  const chars: Char[] = [];
  glyphs.forEach((g, gi) => {
    const t = g.text.normalize("NFKC");
    for (let k = 0; k < t.length; k++) {
      const f0 = k / t.length;
      const f1 = (k + 1) / t.length;
      const lerp = (f: number): Point => [g.a[0] + (g.b[0] - g.a[0]) * f, g.a[1] + (g.b[1] - g.a[1]) * f];
      chars.push({ c: t[k], a: lerp(f0), b: lerp(f1), gi });
    }
  });
  let from = 0;
  for (const run of runs) {
    if (run.flow === "angled") continue;
    // Right-to-left text is drawn in the other order from how pdf.js gives it.
    const orders = run.flow === "left" ? [false, true] : [false];
    for (const backwards of orders) {
      const str = backwards ? [...run.str].reverse().join("") : run.str;
      const got = findRun(str, chars, from, run);
      if (!got) continue;
      run.spans = backwards ? got.spans.reverse() : got.spans;
      // The glyphs it lined up with, so a caller can tell which operations drew it.
      run.glyphs = [chars[got.start].gi, chars[got.end - 1].gi + 1];
      run.units = backwards ? got.units.reverse() : got.units;
      from = got.end;
      break;
    }
  }
}

/** One UTF-16 unit of a drawn letter, and the glyph it came from. */
type Char = { c: string; a: Point; b: Point; gi: number };

/** The first place from `from` where `str` lines up with the drawn letters and lands on its run. */
function findRun(str: string, chars: Char[], from: number, run: TextRun): { spans: [number, number][]; units: number[]; start: number; end: number } | null {
  const first = [...str].findIndex((c) => !space(c));
  if (first < 0) return null;
  const firstChar = str[first].normalize("NFKC")[0];
  const along = run.flow === "right" || run.flow === "left";
  const axis = along ? 0 : 1;
  const [r0, r1] = along ? [run.rect.x0, run.rect.x1] : [run.rect.y0, run.rect.y1];
  const room = along ? run.rect.y1 - run.rect.y0 : run.rect.x1 - run.rect.x0;
  for (let p = from; p < Math.min(chars.length, from + LOOK_AHEAD); p++) {
    if (chars[p].c !== firstChar) continue;
    const got = lineUp(str, chars, p, first);
    if (!got) continue;
    const spans = fillGaps(got.spans.map(([a, b]): [number, number] => (a === null ? [NaN, NaN] : [Math.min(a[axis], b![axis]), Math.max(a[axis], b![axis])])));
    const lo = Math.min(...spans.map((s) => s[0]));
    const hi = Math.max(...spans.map((s) => s[1]));
    // Letters that land well away from their run were the wrong ones.
    if (!Number.isFinite(lo) || lo < r0 - room || hi > r1 + room) continue;
    return { spans, units: got.units, start: p, end: got.end };
  }
  return null;
}

/** Matches `str` (its letters from `first`) to the drawn letters from `p`: each unit's start and end, or null for a space pdf.js put in. */
function lineUp(str: string, chars: Char[], p: number, first: number): { spans: ([Point, Point] | [null, null])[]; units: number[]; end: number } | null {
  const spans: ([Point, Point] | [null, null])[] = Array.from({ length: first }, () => [null, null]);
  /** The glyph each unit came from; -1 for a space pdf.js put in. */
  const units: number[] = Array.from({ length: first }, () => -1);
  let j = p;
  for (let i = first; i < str.length; i++) {
    const u = str[i];
    if (space(u)) {
      if (j < chars.length && space(chars[j].c)) {
        spans.push([chars[j].a, chars[j].b]);
        units.push(chars[j].gi);
        j++;
      } else {
        spans.push([null, null]);
        units.push(-1);
      }
      continue;
    }
    // Spaces drawn but not in the run.
    while (j < chars.length && space(chars[j].c)) j++;
    const want = u.normalize("NFKC");
    let a: Point | null = null;
    let b: Point | null = null;
    let gi = -1;
    for (const c of want) {
      if (j >= chars.length || chars[j].c !== c) return null;
      a ??= chars[j].a;
      b = chars[j].b;
      if (gi < 0) gi = chars[j].gi;
      j++;
    }
    spans.push(a && b ? [a, b] : [null, null]);
    units.push(gi);
  }
  return { spans, units, end: j };
}

/** Spaces pdf.js put in sit between the letters either side. */
function fillGaps(spans: [number, number][]): [number, number][] {
  const out = spans.map((s) => [...s] as [number, number]);
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i][0])) continue;
    const prev = out.slice(0, i).reverse().find((s) => Number.isFinite(s[0]));
    const next = out.slice(i + 1).find((s) => Number.isFinite(s[0]));
    const a = prev ? prev[1] : next ? next[0] : NaN;
    const b = next ? next[0] : a;
    out[i] = [Math.min(a, b), Math.max(a, b)];
  }
  return out;
}

/** What a comment, link or field says, as pdf.js reads it: its note, value, shown text, name in the list and address. */
function noteTexts(a: Record<string, unknown>): string[] {
  const out: unknown[] = [
    (a.contentsObj as { str?: string } | undefined)?.str,
    (a.richText as { str?: string } | undefined)?.str,
    (a.titleObj as { str?: string } | undefined)?.str,
    a.alternativeText,
    a.url,
    a.unsafeUrl,
  ];
  const value = a.fieldValue;
  if (Array.isArray(value)) out.push(...value);
  else out.push(value);
  if (Array.isArray(a.textContent)) out.push((a.textContent as string[]).join("\n"));
  if (Array.isArray(a.options)) for (const o of a.options as { displayValue?: string; exportValue?: string }[]) out.push(o.displayValue, o.exportValue);
  const seen = new Set<string>();
  return out.filter((t): t is string => {
    if (typeof t !== "string" || !t.trim() || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}
