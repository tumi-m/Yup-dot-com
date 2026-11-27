/**
 * The maths of a scanned page: the four corners of the paper in a photo,
 * the perspective transform that flattens them into a rectangle, and the
 * paper's true shape. Corners are kept as fractions of the photo's width and
 * height (0..1), so they hold for the photo at any resolution: the small copy
 * the corners are found on, the one shown on screen and the full one.
 *
 * No browser APIs: unit-tested in Node.
 */

export interface Point {
  x: number;
  y: number;
}

/** Top-left, top-right, bottom-right, bottom-left, as the page reads. */
export type Quad = [Point, Point, Point, Point];

export const CORNER_NAMES = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

/**
 * The whole photo, `inset` in from each edge. Corners start at the photo's
 * own corners when the paper's edges aren't found: most often the page
 * fills the photo (or it is a screenshot), and a box in from the edges cut
 * off its title and the ends of its lines.
 */
export function insetQuad(inset = 0): Quad {
  const a = inset;
  const b = 1 - inset;
  return [
    { x: a, y: a },
    { x: b, y: a },
    { x: b, y: b },
    { x: a, y: b },
  ];
}

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Area of a polygon (shoelace), always positive. */
export function polygonArea(points: Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/**
 * Four points in reading order: the corner nearest the top-left first, then
 * clockwise as seen on screen (y grows downwards).
 */
export function orderQuad(points: Point[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  // Clockwise on screen is increasing angle when y points down.
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[first].x + sorted[first].y) first = i;
  return [0, 1, 2, 3].map((i) => sorted[(first + i) % 4]) as Quad;
}

/** True when the corners make a convex shape with no corner folded over another. */
export function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (Math.abs(c) < 1e-9) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Interior angles in degrees, corner by corner. */
export function quadAngles(q: Quad): number[] {
  return q.map((p, i) => {
    const a = q[(i + 3) % 4];
    const b = q[(i + 1) % 4];
    const v1 = { x: a.x - p.x, y: a.y - p.y };
    const v2 = { x: b.x - p.x, y: b.y - p.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  });
}

/** Corners from fractions of the photo to its pixels. */
export const toPixels = (q: Quad, width: number, height: number): Quad => q.map((p) => ({ x: p.x * width, y: p.y * height })) as Quad;

/** Corners from pixels to fractions of the photo. */
export const toFractions = (q: Quad, width: number, height: number): Quad => q.map((p) => ({ x: p.x / width, y: p.y / height })) as Quad;

/** A 3x3 matrix, row by row, with the last entry 1. */
export type Homography = [number, number, number, number, number, number, number, number, number];

/** Solves a x = b by Gaussian elimination with partial pivoting; null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** The perspective transform that takes each corner of `from` to the same corner of `to`. */
export function homography(from: Quad, to: Quad): Homography | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(a, b);
  return h ? ([...h, 1] as Homography) : null;
}

export function project(h: Homography, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8];
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w };
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** A phone's main camera: focal length about 0.8 of the picture's long side (a 26 mm lens). */
const TYPICAL_FOCAL = 0.8;

/**
 * The paper's width over its height, from its corners in a photo of
 * `width`×`height` pixels. A photo taken at an angle shortens the far edge,
 * so edge lengths alone get the shape wrong; this works back through the
 * camera (the corners of a rectangle fix its focal length, taking the
 * picture's centre as the lens's), after Zhang and He's whiteboard scanning
 * method. Seen nearly face on, the camera can't be worked out, and the edge
 * lengths are right anyway.
 */
export function paperAspect(q: Quad, width: number, height: number): number {
  const [tl, tr, br, bl] = q;
  const edges = (dist(tl, tr) + dist(bl, br)) / 2 / ((dist(tl, bl) + dist(tr, br)) / 2 || 1);
  const u0 = width / 2;
  const v0 = height / 2;
  // Homogeneous points: m1 top-left, m2 top-right, m3 bottom-left, m4 bottom-right.
  const m1 = [tl.x, tl.y, 1];
  const m2 = [tr.x, tr.y, 1];
  const m3 = [bl.x, bl.y, 1];
  const m4 = [br.x, br.y, 1];
  const cr = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const d2 = dot(cr(m2, m4), m3);
  const d3 = dot(cr(m3, m4), m2);
  if (!d2 || !d3) return edges;
  const k2 = dot(cr(m1, m4), m3) / d2;
  const k3 = dot(cr(m1, m4), m2) / d3;
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];
  // The focal length the corners imply; seen face on, or tilted one way
  // only, they don't fix it, and a phone's usual lens stands in.
  const long = Math.max(width, height);
  const lens = (TYPICAL_FOCAL * long) ** 2;
  const denom = n2[2] * n3[2];
  let f2 =
    Math.abs(denom) > 1e-9
      ? -(
          n2[0] * n3[0] -
          (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
          n2[2] * n3[2] * u0 * u0 +
          (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)
        ) / denom
      : NaN;
  if (!(f2 > (0.3 * long) ** 2 && f2 < (4 * long) ** 2)) f2 = lens;
  // |A^-1 n|^2 with A the camera matrix [[f,0,u0],[0,f,v0],[0,0,1]].
  const len = (n: number[]) => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / f2 + n[2] ** 2;
  const aspect = Math.sqrt(len(n2) / len(n3));
  // A wild answer (corners dragged into a strange shape) is no better than the edges.
  return Number.isFinite(aspect) && aspect > edges / 3 && aspect < edges * 3 ? aspect : edges;
}

/**
 * Pixel size of the flattened page: the paper's shape, with as many pixels
 * as the paper covers in the photo (no more: they'd be made up), the long
 * side at most `maxLong`.
 */
export function flatSize(q: Quad, width: number, height: number, maxLong: number): { width: number; height: number } {
  const px = toPixels(q, width, height);
  const aspect = paperAspect(px, width, height);
  const area = polygonArea(px);
  let w = Math.sqrt(area * aspect);
  let h = Math.sqrt(area / aspect);
  const scale = Math.min(1, maxLong / Math.max(w, h));
  w *= scale;
  h *= scale;
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/** Keeps a corner on the photo. */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Moves one corner, kept on the photo. A move that would fold the shape over is refused (null). */
export function moveCorner(q: Quad, index: number, to: Point): Quad | null {
  const next = q.map((p, i) => (i === index ? { x: clamp01(to.x), y: clamp01(to.y) } : p)) as Quad;
  return isConvex(next) ? next : null;
}

/**
 * Arrow keys on a corner: a small step, ten times further with Shift.
 * Null for any other key, or when the move would fold the shape.
 */
export function nudgeCorner(q: Quad, index: number, key: { key: string; shiftKey?: boolean }): Quad | null {
  const step = key.shiftKey ? 0.05 : 0.005;
  const d: Record<string, Point> = {
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
  };
  const move = d[key.key];
  if (!move) return null;
  return moveCorner(q, index, { x: q[index].x + move.x, y: q[index].y + move.y });
}

/** "12% from the left, 8% from the top", for screen readers. */
export function describeCorner(p: Point): string {
  return `${Math.round(p.x * 100)}% from the left, ${Math.round(p.y * 100)}% from the top`;
}
