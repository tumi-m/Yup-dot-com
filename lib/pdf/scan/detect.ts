/**
 * Finds a sheet of paper in a photo: its four corners, or null when no
 * shape stands out well enough to guess.
 *
 * Works on a small grey copy (about 256 pixels across), so it takes a few
 * milliseconds on a phone. Paper is usually lighter (or darker) than what it
 * lies on, so the picture is cut at several brightness levels; each patch
 * that is big enough becomes a candidate, its outline is reduced to the
 * four-sided shape that covers most of it, and that shape is scored by how
 * much of it the patch fills and how much of its outline runs along a real
 * edge in the picture. Clutter that touches the paper is cut off by an
 * opening (shrink, then grow), and a few brightness levels between them cope
 * with a shadow across the sheet. The best shape's edges are then fitted to
 * the strongest nearby edge pixels for precise corners.
 *
 * No browser APIs: unit-tested in Node on drawn pictures.
 */
import type { RawImage } from "../../image-codec";
import { isConvex, orderQuad, polygonArea, quadAngles, type Point, type Quad } from "./geometry";

/** The long side the search runs at. */
const WORK_SIDE = 256;

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

export interface Found {
  /** Fractions of the photo's width and height. */
  quad: Quad;
  /** 0..1: how sure the search is. */
  score: number;
}

/** Brightness (Rec. 601), shrunk so the long side is at most `side`, by averaging. */
export function grayOf(img: RawImage, side = WORK_SIDE): Gray {
  const scale = Math.min(1, side / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const sum = new Float32Array(width * height);
  const count = new Float32Array(width * height);
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(height - 1, Math.floor((y * height) / img.height));
    for (let x = 0; x < img.width; x++) {
      const tx = Math.min(width - 1, Math.floor((x * width) / img.width));
      const p = (y * img.width + x) * 4;
      sum[ty * width + tx] += 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      count[ty * width + tx]++;
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] /= count[i] || 1;
  return { data: sum, width, height };
}

/** A box blur of radius r, along rows then columns (twice is close to a Gaussian). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        s += src[y * w + xx];
        n++;
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        s += tmp[yy * w + x];
        n++;
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/** Sobel gradient: strength, and direction in radians. */
function gradient(src: Float32Array, w: number, h: number): { mag: Float32Array; dir: Float32Array } {
  const mag = new Float32Array(src.length);
  const dir = new Float32Array(src.length);
  const at = (x: number, y: number) => src[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      mag[y * w + x] = Math.hypot(gx, gy);
      dir[y * w + x] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

/** Edge pixels thinned to the ridge of the gradient (non-maximum suppression). */
function thinEdges(mag: Float32Array, dir: Float32Array, w: number, h: number, strong: number): number[] {
  const out: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < strong) continue;
      const dx = Math.round(Math.cos(dir[i]));
      const dy = Math.round(Math.sin(dir[i]));
      if (m >= mag[i + dy * w + dx] && m >= mag[i - dy * w - dx]) out.push(i);
    }
  }
  return out;
}

interface Line {
  /** A point on the line and its direction. */
  px: number;
  py: number;
  dx: number;
  dy: number;
}

/**
 * The strongest straight lines through the edge pixels (a Hough transform:
 * every edge pixel votes for each line through it, in 1° steps), at most
 * `count`, no two nearly the same.
 */
function houghLines(edges: number[], w: number, h: number, count: number): Line[] {
  const steps = 180;
  const diag = Math.ceil(Math.hypot(w, h));
  const bins = diag * 2 + 1;
  const acc = new Int32Array(steps * bins);
  const cos = new Float32Array(steps);
  const sin = new Float32Array(steps);
  for (let t = 0; t < steps; t++) {
    cos[t] = Math.cos((t * Math.PI) / steps);
    sin[t] = Math.sin((t * Math.PI) / steps);
  }
  for (const i of edges) {
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    for (let t = 0; t < steps; t++) acc[t * bins + Math.round(x * cos[t] + y * sin[t]) + diag]++;
  }
  const lines: Line[] = [];
  const taken: { t: number; r: number }[] = [];
  const minVotes = Math.max(12, Math.min(w, h) * 0.12);
  // Peaks, strongest first, skipping any close to one already taken.
  const order = Array.from(acc.keys()).filter((k) => acc[k] >= minVotes).sort((a, b) => acc[b] - acc[a]);
  for (const k of order) {
    if (lines.length >= count) break;
    const t = Math.floor(k / bins);
    const r = (k % bins) - diag;
    const near = taken.some((o) => {
      const dt = Math.min(Math.abs(o.t - t), steps - Math.abs(o.t - t));
      // Across 0°/180° the same line has the opposite rho.
      const dr = Math.abs(o.t - t) > steps / 2 ? Math.abs(o.r + r) : Math.abs(o.r - r);
      return dt <= 6 && dr <= Math.max(6, diag * 0.02);
    });
    if (near) continue;
    taken.push({ t, r });
    // The normal is (cos, sin); the line runs along (-sin, cos).
    lines.push({ px: r * cos[t], py: r * sin[t], dx: -sin[t], dy: cos[t] });
  }
  return lines;
}

function meet(l1: Line, l2: Line): Point | null {
  const det = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / det;
  return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
}

/** Four-sided shapes made of two pairs of the lines, with their corners on (or just off) the photo. */
function lineQuads(lines: Line[], w: number, h: number): Quad[] {
  const out: Quad[] = [];
  const n = lines.length;
  const slack = Math.max(w, h) * 0.02;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = 0; c < n; c++) {
        if (c === a || c === b) continue;
        for (let d = c + 1; d < n; d++) {
          if (d === a || d === b) continue;
          // a and b are opposite sides; so are c and d. Each pairing once.
          if (Math.min(c, d) < a) continue;
          const pts = [meet(lines[a], lines[c]), meet(lines[c], lines[b]), meet(lines[b], lines[d]), meet(lines[d], lines[a])];
          if (pts.some((p) => !p || p.x < -slack || p.y < -slack || p.x > w + slack || p.y > h + slack)) continue;
          out.push(orderQuad(pts as Point[]));
        }
      }
    }
  }
  return out;
}

/** Otsu's threshold of 0..255 values. */
function otsu(values: Float32Array): number {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let at = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      at = t;
    }
  }
  return at;
}

/** Shrinks (min) or grows (max) a 0/1 mask by a square of radius r. */
function morph(mask: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const want = grow ? 1 : 0;
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1 - want;
      for (let k = -r; k <= r && v !== want; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && mask[y * w + xx] === want) v = want;
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1 - want;
      for (let k = -r; k <= r && v !== want; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h && tmp[yy * w + x] === want) v = want;
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

interface Patch {
  area: number;
  /** Leftmost and rightmost pixel of each row it spans. */
  rows: Map<number, [number, number]>;
}

/** The mask's connected patches (4-neighbours) of at least `minArea` pixels. */
function patches(mask: Uint8Array, w: number, h: number, minArea: number): Patch[] {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const out: Patch[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    const rows = new Map<number, [number, number]>();
    while (top) {
      const i = stack[--top];
      area++;
      const x = i % w;
      const y = (i - x) / w;
      const row = rows.get(y);
      if (!row) rows.set(y, [x, x]);
      else {
        if (x < row[0]) row[0] = x;
        if (x > row[1]) row[1] = x;
      }
      if (x > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (y > 0 && mask[i - w] && !seen[i - w]) (seen[i - w] = 1), (stack[top++] = i - w);
      if (y < h - 1 && mask[i + w] && !seen[i + w]) (seen[i + w] = 1), (stack[top++] = i + w);
    }
    if (area >= minArea) out.push({ area, rows });
  }
  return out;
}

/** Convex hull (monotone chain) of a patch's outline, clockwise on screen. */
function hullOf(patch: Patch): Point[] {
  const pts: Point[] = [];
  for (const [y, [a, b]] of patch.rows) {
    // Pixel edges, so a patch's hull covers its pixels.
    pts.push({ x: a, y }, { x: a, y: y + 1 }, { x: b + 1, y }, { x: b + 1, y: y + 1 });
  }
  pts.sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Drops hull points that barely turn, so the quad search has few to try. */
function simplify(hull: Point[], max = 48): Point[] {
  let pts = hull;
  let tol = 0.5;
  while (pts.length > max) {
    const keep: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      // Twice the triangle's area over the base: how far b sticks out of a-c.
      const out = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / (Math.hypot(c.x - a.x, c.y - a.y) || 1);
      if (out > tol) keep.push(b);
    }
    pts = keep.length >= 4 ? keep : pts.filter((_, i) => i % 2 === 0);
    tol *= 1.6;
  }
  return pts;
}

/** The largest four-cornered shape with its corners on the hull's points. */
function largestQuad(pts: Point[]): Point[] | null {
  const n = pts.length;
  if (n < 4) return null;
  const tri = (a: Point, b: Point, c: Point) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  let best = 0;
  let pick: Point[] | null = null;
  for (let i = 0; i < n; i++) {
    for (let k = i + 2; k < n; k++) {
      // Best corner on each side of the diagonal i-k.
      let bj = -1;
      let aj = 0;
      for (let j = i + 1; j < k; j++) {
        const a = tri(pts[i], pts[j], pts[k]);
        if (a > aj) (aj = a), (bj = j);
      }
      let bl = -1;
      let al = 0;
      for (let l = k + 1; l < n + i; l++) {
        const a = tri(pts[i], pts[k], pts[l % n]);
        if (a > al) (al = a), (bl = l % n);
      }
      if (bj < 0 || bl < 0) continue;
      if (aj + al > best) {
        best = aj + al;
        pick = [pts[i], pts[bj], pts[k], pts[bl]];
      }
    }
  }
  return pick;
}

/** Share of points along the quad's edges that sit on a strong edge in the picture. */
function edgeSupport(q: Quad, g: Float32Array, w: number, h: number, strong: number): number {
  let total = 0;
  let worst = 1;
  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(8, Math.round(len / 2));
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    let hit = 0;
    let n = 0;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      n++;
      for (let o = -2; o <= 2; o++) {
        const xx = Math.round(x + nx * o - 0.5);
        const yy = Math.round(y + ny * o - 0.5);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (g[yy * w + xx] >= strong) {
          hit++;
          break;
        }
      }
    }
    const share = n ? hit / n : 0;
    total += share;
    worst = Math.min(worst, share);
  }
  // An edge with no support at all (paper running off the photo) costs less than a missing edge would.
  return (total / 4) * 0.8 + worst * 0.2;
}

/**
 * How much the shape looks like one sheet: just inside its edges is clearly
 * lighter (or clearly darker) than just outside, all the way round. Four
 * unrelated straight edges on a cluttered table don't agree like that.
 */
function sideContrast(q: Quad, img: Float32Array, w: number, h: number): number {
  const at = (x: number, y: number) => img[Math.min(h - 1, Math.max(0, Math.round(y - 0.5))) * w + Math.min(w - 1, Math.max(0, Math.round(x - 0.5)))];
  // The shape's corners run clockwise on screen, so inward is to the right of each edge.
  let lighter = 0;
  let darker = 0;
  let n = 0;
  const off = Math.max(2, Math.max(w, h) / 80);
  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    for (let s = 1; s < 20; s++) {
      const t = s / 20;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const d = at(x + nx * off, y + ny * off) - at(x - nx * off, y - ny * off);
      n++;
      if (d > 12) lighter++;
      else if (d < -12) darker++;
    }
  }
  return Math.max(lighter, darker) / n;
}

/**
 * Moves each edge onto the strongest edge pixels near it (a straight line
 * fitted through them), then takes the corners where the lines meet. Keeps
 * the shape as it was where that doesn't give a sensible one.
 */
function refine(q: Quad, g: Float32Array, w: number, h: number, strong: number): Quad {
  const lines: Line[] = [];
  for (let e = 0; e < 4; e++) {
    const a = q[e];
    const b = q[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / (len || 1);
    const ny = (b.x - a.x) / (len || 1);
    const steps = Math.max(10, Math.round(len));
    const pts: Point[] = [];
    // The middle of the edge only: corners are where two edges blur together.
    for (let s = Math.round(steps * 0.1); s <= Math.round(steps * 0.9); s++) {
      const t = s / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      let bestG = strong;
      let bestO: number | null = null;
      for (let o = -4; o <= 4; o += 0.5) {
        const xx = Math.round(x + nx * o - 0.5);
        const yy = Math.round(y + ny * o - 0.5);
        if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
        const v = g[yy * w + xx];
        if (v > bestG) (bestG = v), (bestO = o);
      }
      if (bestO !== null) pts.push({ x: x + nx * bestO, y: y + ny * bestO });
    }
    if (pts.length < 6) {
      lines.push({ px: a.x, py: a.y, dx: b.x - a.x, dy: b.y - a.y });
      continue;
    }
    // Total least squares, then once more without the points furthest off.
    let fit = fitLine(pts);
    const off = pts.map((p) => Math.abs((p.x - fit.px) * -fit.dy + (p.y - fit.py) * fit.dx));
    const cut = [...off].sort((m, n) => m - n)[Math.floor(off.length * 0.8)];
    const kept = pts.filter((_, i) => off[i] <= cut);
    if (kept.length >= 6) fit = fitLine(kept);
    lines.push(fit);
  }
  const corners: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const p = meet(lines[(i + 3) % 4], lines[i]);
    if (!p) return q;
    corners.push(p);
  }
  const out = corners as Quad;
  const diag = Math.hypot(w, h);
  const moved = Math.max(...out.map((p, i) => Math.hypot(p.x - q[i].x, p.y - q[i].y)));
  const inside = out.every((p) => p.x >= -1 && p.y >= -1 && p.x <= w + 1 && p.y <= h + 1);
  return isConvex(out) && inside && moved < diag * 0.04 ? out : q;
}

/**
 * Each corner moved `by` pixels towards the middle: the edge found is the
 * middle of a blurred step, half of it table, which would show as a dark
 * line round the page.
 */
function inset(q: Quad, by: number): Quad {
  const cx = q.reduce((s, p) => s + p.x, 0) / 4;
  const cy = q.reduce((s, p) => s + p.y, 0) / 4;
  return q.map((p) => {
    const d = Math.hypot(cx - p.x, cy - p.y) || 1;
    return { x: p.x + ((cx - p.x) / d) * by, y: p.y + ((cy - p.y) / d) * by };
  }) as Quad;
}

function fitLine(pts: Point[]): Line {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  return { px: mx, py: my, dx: Math.cos(angle), dy: Math.sin(angle) };
}

/** Sensible as a sheet of paper: big enough, not the whole photo, no corner too sharp. */
function plausible(quad: Quad, total: number): number | null {
  if (!isConvex(quad)) return null;
  const area = polygonArea(quad);
  // The whole photo: nothing to find (the paper fills it, or isn't there).
  if (area < total * 0.05 || area > total * 0.97) return null;
  if (quadAngles(quad).some((a) => a < 35 || a > 145)) return null;
  return area;
}

/** Bigger is likelier the subject (a shadow across the sheet mustn't win with the lit half), up to half the photo. */
const sizeFactor = (area: number, total: number) => Math.min(1, Math.sqrt(area / total / 0.5));

/** Finds the paper in a photo (any size: it is shrunk first). */
export function findDocument(img: RawImage): Found | null {
  const gray = grayOf(img);
  const { width: w, height: h } = gray;
  if (w < 16 || h < 16) return null;
  const blurred = boxBlur(boxBlur(gray.data, w, h, 1), w, h, 1);
  // Edges are measured on log brightness: a shadow dims both sides of an
  // edge by the same factor, so the paper's edge in shadow counts as fully
  // as in the light. 46 ln(1 + v) keeps 0..255.
  const lit = blurred.map((v) => 46 * Math.log1p(v));
  const { mag: g, dir } = gradient(lit, w, h);
  // A strong edge: well above the picture's typical texture.
  const sorted = Float32Array.from(g).sort();
  const strong = Math.max(40, sorted[Math.floor(sorted.length * 0.75)] * 2);
  const total = w * h;
  let best: { quad: Quad; score: number } | null = null;
  const consider = (quad: Quad, score: number) => {
    if (!best || score > best.score) best = { quad, score };
  };

  // Patches of light (or dark) brightness, each reduced to its biggest four-sided shape.
  const t0 = otsu(blurred);
  const levels = [t0, t0 - 25, t0 + 25, t0 - 50, t0 + 50].filter((t) => t > 10 && t < 245);
  const r = Math.max(1, Math.round(Math.max(w, h) / 128));
  for (const t of levels) {
    for (const lighter of [true, false]) {
      const raw = new Uint8Array(total);
      for (let i = 0; i < total; i++) raw[i] = (lighter ? blurred[i] > t : blurred[i] < t) ? 1 : 0;
      for (const radius of [r, r * 3]) {
        const mask = morph(morph(raw, w, h, radius, false), w, h, radius, true);
        for (const patch of patches(mask, w, h, total * 0.05)) {
          const hull = hullOf(patch);
          const corners = largestQuad(simplify(hull));
          if (!corners) continue;
          const quad = orderQuad(corners);
          const area = plausible(quad, total);
          if (area === null) continue;
          const quadness = area / (polygonArea(hull) || 1);
          const fill = Math.min(1, patch.area / area);
          const score = edgeSupport(quad, g, w, h, strong) * sideContrast(quad, lit, w, h) * quadness * Math.min(1, fill / 0.9);
          consider(quad, score * sizeFactor(area, total));
        }
      }
    }
  }

  // Straight edges, paired into shapes: finds paper whose patch ran into
  // something as light as itself (a mug, another sheet) where the edges show.
  const lines = houghLines(thinEdges(g, dir, w, h, strong), w, h, 14);
  for (const quad of lineQuads(lines, w, h)) {
    const area = plausible(quad, total);
    if (area === null) continue;
    consider(quad, edgeSupport(quad, g, w, h, strong) * sideContrast(quad, lit, w, h) * sizeFactor(area, total));
  }

  const found = best as { quad: Quad; score: number } | null;
  if (!found || found.score < 0.3) return null;
  const sharp = inset(refine(found.quad, g, w, h, strong), 1.8);
  return { quad: sharp.map((p) => ({ x: Math.min(1, Math.max(0, p.x / w)), y: Math.min(1, Math.max(0, p.y / h)) })) as Quad, score: found.score };
}
