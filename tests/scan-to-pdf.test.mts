// Scan to PDF: the paper found in drawn photos (a light sheet turned and
// seen at an angle on a dark, cluttered table, under uneven light, with a
// shadow, running off the photo, and none at all), the perspective maths
// (a known rectangle seen through a known camera comes back its own shape),
// the warp that flattens it, the Document filter that keeps paper white in
// shadow, turning, corners moved by keys, and whole PDFs opened again with
// pdf-lib and pdf.js: page count, sizes per option, page order, pixels,
// filters, many pages and photos that can't be read. Then the camera's
// error messages, the tool's registration and the camera permission header.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value, error: null as Error | null }), (error: Error) => ({ value: null, error }));

const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});
const geo = await import("../lib/pdf/scan/geometry.ts");
const { findDocument } = await import("../lib/pdf/scan/detect.ts");
const { warpQuad } = await import("../lib/pdf/scan/warp.ts");
const { documentBw, grayscale, turn, applyFilter } = await import("../lib/pdf/scan/filters.ts");
const { buildScanPdf, flattenPage } = await import("../lib/pdf/scan/build.ts");
type Quad = import("../lib/pdf/scan/geometry.ts").Quad;
type RawImage = import("../lib/image-codec.ts").RawImage;

// ---------------------------------------------------------------------------
// Drawn photos
// ---------------------------------------------------------------------------

/** A repeatable random sequence. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Scene {
  width: number;
  height: number;
  /** The paper's corners in pixels, reading order. */
  paper: Quad;
  /** Brightness of the paper and the table, 0..255. */
  paperLevel?: number;
  table?: number;
  /** Shapes and lines on the table. */
  clutter?: number;
  /** Discs on the table, under the paper: a light one touching it is the hard case. */
  discs?: { x: number; y: number; r: number; level: number }[];
  /** Light falling off from left to right: 0 even, 0.6 strong. */
  falloff?: number;
  /** A shadow over the right part of the photo, from this fraction of the width: its brightness factor. */
  shadow?: { from: number; factor: number };
  seed?: number;
}

/**
 * A photo of a sheet with lines of "text" on a table. The sheet is drawn
 * through the perspective transform of its corners, 2x2 samples a pixel, so
 * its edges are soft as a camera's are. Ink marks: `ink(u, v)` true in the
 * paper's own 0..1 coordinates.
 */
function drawScene(sc: Scene): RawImage {
  const { width, height } = sc;
  const rand = rng(sc.seed ?? 1);
  const data = new Uint8ClampedArray(width * height * 4);
  const table = sc.table ?? 45;
  const paperLevel = sc.paperLevel ?? 225;
  // Clutter: rectangles and discs of various greys, some fairly light, and lines.
  const shapes: { kind: "rect" | "disc" | "line"; x: number; y: number; a: number; b: number; level: number }[] = [];
  for (let i = 0; i < (sc.clutter ?? 0); i++) {
    const kind = (["rect", "disc", "line"] as const)[Math.floor(rand() * 3)];
    shapes.push({ kind, x: rand() * width, y: rand() * height, a: 10 + rand() * width * 0.12, b: 4 + rand() * height * 0.1, level: 15 + rand() * 150 });
  }
  const toPaper = geo.homography(sc.paper, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ])!;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let back = table + Math.sin(x / 9 + Math.sin(y / 40) * 3) * 8;
      for (const s of shapes) {
        const inside =
          s.kind === "rect"
            ? Math.abs(x - s.x) < s.a / 2 && Math.abs(y - s.y) < s.b / 2
            : s.kind === "disc"
              ? Math.hypot(x - s.x, y - s.y) < s.b
              : Math.abs((x - s.x) * 0.3 - (y - s.y)) < 1.5 && Math.abs(x - s.x) < s.a * 2;
        if (inside) back = s.level;
      }
      for (const d of sc.discs ?? []) if (Math.hypot(x - d.x, y - d.y) < d.r) back = d.level;
      let paper = 0;
      let inkHits = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const p = geo.project(toPaper, { x: x + ox, y: y + oy });
        if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
          paper++;
          if (ink(p.x, p.y)) inkHits++;
        }
      }
      const paperValue = paperLevel - (inkHits / Math.max(1, paper)) * (paperLevel - 40);
      let v = (back * (4 - paper) + paperValue * paper) / 4;
      const light = 1 - (sc.falloff ?? 0) * (x / width);
      v *= light;
      if (sc.shadow && x > sc.shadow.from * width) v *= sc.shadow.factor;
      v += (rand() - 0.5) * 10;
      const o = (y * width + x) * 4;
      data[o] = v + 6;
      data[o + 1] = v;
      data[o + 2] = v - 6;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Lines of text on the paper: short dark strokes in rows, with margins. */
function ink(u: number, v: number): boolean {
  if (u < 0.1 || u > 0.9 || v < 0.1 || v > 0.9) return false;
  const row = (v - 0.1) / 0.04;
  if (row - Math.floor(row) > 0.35) return false;
  // Words: breaks along the line.
  const word = Math.sin(u * 60 + Math.floor(row) * 1.7);
  return word > -0.6;
}

/** The furthest any found corner is from the true one, as a share of the photo's diagonal. */
function cornerError(found: Quad, truth: Quad, width: number, height: number) {
  const diag = Math.hypot(width, height);
  return Math.max(...found.map((p, i) => Math.hypot(p.x * width - truth[i].x, p.y * height - truth[i].y))) / diag;
}

/** The corners of a w×h rectangle turned by `angle` about (cx, cy), with its far edge shortened by `tilt`. */
function sheet(cx: number, cy: number, w: number, h: number, angle: number, tilt = 0): Quad {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const pts = [
    [-w / 2 * (1 - tilt), -h / 2],
    [w / 2 * (1 - tilt), -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return pts.map(([x, y]) => ({ x: cx + x * c - y * s, y: cy + x * s + y * c })) as Quad;
}

// ---------------------------------------------------------------------------
// Finding the paper
// ---------------------------------------------------------------------------
{
  const cases: { name: string; scene: Scene; within: number }[] = [
    { name: "straight sheet on a plain table", scene: { width: 640, height: 480, paper: sheet(320, 240, 300, 400 * 0.95, 0) }, within: 0.008 },
    {
      name: "turned 20° and seen at an angle, on a cluttered table",
      scene: { width: 800, height: 600, paper: sheet(400, 300, 330, 440, 0.35, 0.18), clutter: 40, seed: 7 },
      within: 0.008,
    },
    {
      name: "turned the other way, lit unevenly from the left",
      scene: { width: 600, height: 800, paper: sheet(300, 400, 380, 520, -0.3, 0.1), clutter: 30, falloff: 0.55, seed: 3 },
      within: 0.008,
    },
    {
      name: "a light mug touching the sheet's edge, and a light box near it",
      scene: {
        width: 800,
        height: 600,
        paper: sheet(380, 300, 320, 420, 0.25, 0.1),
        clutter: 20,
        discs: [
          { x: 590, y: 330, r: 70, level: 215 },
          { x: 120, y: 110, r: 60, level: 200 },
        ],
        seed: 13,
      },
      within: 0.01,
    },
    {
      name: "a hard shadow across the sheet",
      scene: { width: 800, height: 600, paper: sheet(390, 310, 320, 430, 0.2, 0.12), clutter: 25, shadow: { from: 0.55, factor: 0.55 }, seed: 11 },
      within: 0.01,
    },
    {
      name: "a grey sheet on a lighter table (darker than what's round it)",
      scene: { width: 640, height: 480, paper: sheet(330, 240, 260, 340, 0.15, 0.05), paperLevel: 70, table: 190, seed: 5 },
      within: 0.008,
    },
  ];
  for (const c of cases) {
    const img = drawScene(c.scene);
    const t0 = performance.now();
    const found = findDocument(img);
    const ms = performance.now() - t0;
    const err = found ? cornerError(found.quad, c.scene.paper, img.width, img.height) : Infinity;
    check(`finds the paper: ${c.name} (corners within ${(c.within * 100).toFixed(1)}% of the diagonal)`, err <= c.within, { err, found: found?.quad, ms: Math.round(ms) });
  }

  const cut = sheet(380, 300, 360, 700, 0.1);
  const offEdge = drawScene({ width: 640, height: 480, paper: cut, seed: 2 });
  const off = findDocument(offEdge);
  check("paper running off the photo: a shape is still offered, kept on the photo", !!off && off.quad.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1), off);

  const empty = drawScene({ width: 640, height: 480, paper: sheet(-500, -500, 10, 10, 0), clutter: 0, seed: 4 });
  check("a bare table: nothing found", findDocument(empty) === null, findDocument(empty));

  const noise: RawImage = { width: 320, height: 240, data: new Uint8ClampedArray(320 * 240 * 4) };
  const r = rng(9);
  for (let i = 0; i < noise.data.length; i++) noise.data[i] = i % 4 === 3 ? 255 : r() * 255;
  check("pure noise: nothing found", findDocument(noise) === null);
  check("a tiny picture: nothing found, no crash", findDocument({ width: 8, height: 8, data: new Uint8ClampedArray(256).fill(200) }) === null);

  // Fast enough on a phone: the photo is shrunk before the search.
  const big = drawScene({ width: 1600, height: 1200, paper: sheet(800, 600, 700, 950, 0.25, 0.1), clutter: 30, seed: 8 });
  const t0 = performance.now();
  const bigFound = findDocument(big);
  const ms = performance.now() - t0;
  check("a 1600x1200 photo is searched in well under a second", ms < 800 && !!bigFound, { ms });
}

// ---------------------------------------------------------------------------
// Perspective maths
// ---------------------------------------------------------------------------

/** A w×h rectangle (metres) seen by a camera of focal length f (pixels), turned rx, ry, rz and `away` metres off. */
function camera(w: number, h: number, rx: number, ry: number, rz: number, f: number, away: number, iw: number, ih: number): Quad {
  const pts = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  return pts.map(([x, y]) => {
    let X = x;
    let Y = y;
    let Z = 0;
    [X, Y] = [Math.cos(rz) * X - Math.sin(rz) * Y, Math.sin(rz) * X + Math.cos(rz) * Y];
    [Y, Z] = [Math.cos(rx) * Y - Math.sin(rx) * Z, Math.sin(rx) * Y + Math.cos(rx) * Z];
    [X, Z] = [Math.cos(ry) * X + Math.sin(ry) * Z, -Math.sin(ry) * X + Math.cos(ry) * Z];
    Z += away;
    return { x: (f * (X + 0.02)) / Z + iw / 2, y: (f * (Y - 0.01)) / Z + ih / 2 };
  }) as Quad;
}
{
  const from: Quad = [
    { x: 10, y: 20 },
    { x: 300, y: 5 },
    { x: 320, y: 400 },
    { x: 0, y: 380 },
  ];
  const to: Quad = [
    { x: 0, y: 0 },
    { x: 210, y: 0 },
    { x: 210, y: 297 },
    { x: 0, y: 297 },
  ];
  const H = geo.homography(from, to)!;
  const back = from.map((p) => geo.project(H, p));
  check("homography: each corner lands on its corner", back.every((p, i) => Math.hypot(p.x - to[i].x, p.y - to[i].y) < 1e-6), back);
  const inv = geo.homography(to, from)!;
  const mid = geo.project(inv, geo.project(H, { x: 150, y: 200 }));
  check("homography: there and back is where it started", Math.hypot(mid.x - 150, mid.y - 200) < 1e-6, mid);
  const line: Quad = [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
    { x: 20, y: 20 },
    { x: 30, y: 30 },
  ];
  check("homography: corners all on one line have none", geo.homography(line, to) === null && geo.homography(to, line) === null);

  // A4 and Letter seen at angles a phone is held at come back their own shape.
  const a4 = 210 / 297;
  const poses: [number, number, number][] = [
    [0, 0, 0],
    [0.45, 0, 0],
    [0, 0.4, 0.15],
    [0.5, 0.3, 0.4],
    [0.6, -0.35, -0.3],
    [0.05, 0.03, 1.2],
  ];
  const errors = poses.map(([rx, ry, rz]) => geo.paperAspect(camera(0.21, 0.297, rx, ry, rz, 3000, 0.6, 3000, 4000), 3000, 4000) / a4 - 1);
  check("aspect: A4 at six angles within 1.5%", errors.every((e) => Math.abs(e) < 0.015), errors.map((e) => e.toFixed(4)));
  const letter = geo.paperAspect(camera(0.2159, 0.2794, 0.5, 0.25, 0.1, 2400, 0.5, 4000, 3000), 4000, 3000) / (8.5 / 11);
  check("aspect: Letter on a landscape photo within 1.5%", Math.abs(letter - 1) < 0.015, letter);
  // Edge lengths alone get a steep view wrong: the far edge is shorter.
  const steep = camera(0.21, 0.297, 0.6, 0, 0, 3000, 0.5, 3000, 4000);
  const [tl, tr, br, bl] = steep;
  const naive = (Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y)) / (Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y)) / a4;
  const smart = geo.paperAspect(steep, 3000, 4000) / a4;
  // Tilted one way only, the lens can't be worked out and a phone's usual one stands in: a little less exact.
  check("aspect: a steep view is corrected where edge lengths are 10%+ off", Math.abs(naive - 1) > 0.1 && Math.abs(smart - 1) < 0.025, { naive, smart });

  const size = geo.flatSize(geo.toFractions(camera(0.21, 0.297, 0.3, 0.1, 0.2, 3000, 0.45, 3000, 4000), 3000, 4000), 3000, 4000, 3508);
  check("flat size: A4's shape, long side within the cap", Math.abs(size.width / size.height / a4 - 1) < 0.02 && Math.max(size.width, size.height) <= 3508, size);
  const small = geo.flatSize(geo.insetQuad(0.1), 400, 300, 3508);
  check("flat size: as many pixels as the paper covers, flat on", small.width === 320 && small.height === 240, small);

  const shuffled = [
    { x: 0.9, y: 0.85 },
    { x: 0.1, y: 0.1 },
    { x: 0.15, y: 0.9 },
    { x: 0.85, y: 0.12 },
  ];
  const ordered = geo.orderQuad(shuffled);
  check("corners put in reading order", JSON.stringify(ordered) === JSON.stringify([shuffled[1], shuffled[3], shuffled[0], shuffled[2]]), ordered);
  const bowtie: Quad = [
    { x: 0.1, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.9, y: 0.1 },
    { x: 0.1, y: 0.9 },
  ];
  check("a folded shape isn't convex", !geo.isConvex(bowtie) && geo.isConvex(geo.insetQuad()));
  // Edges not found (a page filling the photo, a screenshot): nothing is cut off until a corner is moved.
  check("corners start at the photo's corners", geo.insetQuad().map((p) => `${p.x},${p.y}`).join(" ") === "0,0 1,0 1,1 0,1");

  const q = geo.insetQuad(0.1);
  const right = geo.nudgeCorner(q, 0, { key: "ArrowRight" })!;
  const far = geo.nudgeCorner(q, 0, { key: "ArrowDown", shiftKey: true })!;
  check("arrow key moves a corner a little; Shift ten times further", Math.abs(right[0].x - 0.105) < 1e-9 && Math.abs(far[0].y - 0.15) < 1e-9 && right[1] === q[1]);
  check("other keys don't move it", geo.nudgeCorner(q, 0, { key: "Enter" }) === null);
  check("a corner can't leave the photo", geo.moveCorner(q, 0, { x: -0.5, y: -2 })![0].x === 0 && geo.moveCorner(q, 0, { x: -0.5, y: -2 })![0].y === 0);
  check("a drag that would fold the shape is refused", geo.moveCorner(q, 0, { x: 0.95, y: 0.95 }) === null);
  check("corner read out as people say it", geo.describeCorner({ x: 0.123, y: 0.08 }) === "12% from the left, 8% from the top");
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------
{
  const scene: Scene = { width: 900, height: 700, paper: sheet(450, 350, 380, 520, 0.4, 0.15), clutter: 20, seed: 21 };
  const img = drawScene(scene);
  const quad = geo.toFractions(scene.paper, img.width, img.height);
  const flat = warpQuad(img, quad, 210, 297);
  let agree = 0;
  let n = 0;
  for (let y = 0; y < flat.height; y++) {
    for (let x = 0; x < flat.width; x++) {
      const u = (x + 0.5) / flat.width;
      const v = (y + 0.5) / flat.height;
      // Away from the edges of strokes, where a pixel is half ink.
      const edge = [-0.012, 0.012].some((d) => ink(u + d, v) !== ink(u, v) || ink(u, v + d) !== ink(u, v));
      if (edge) continue;
      n++;
      const dark = flat.data[(y * flat.width + x) * 4 + 1] < 130;
      if (dark === ink(u, v)) agree++;
    }
  }
  check("warp: the flattened page matches the drawn page (97%+ of pixels)", agree / n > 0.97, { agree: agree / n });
  check("warp: output is the size asked, opaque", flat.width === 210 && flat.height === 297 && flat.data[3] === 255 && flat.data[flat.data.length - 1] === 255);
  const corner = (x: number, y: number) => flat.data[(y * flat.width + x) * 4 + 1];
  check("warp: no table at the corners (paper there)", [corner(1, 1), corner(208, 1), corner(208, 295), corner(1, 295)].every((v) => v > 170), [corner(1, 1), corner(208, 1), corner(208, 295), corner(1, 295)]);
  // A big photo flattened small is averaged first: no shimmer from skipped pixels.
  const tiny = warpQuad(img, quad, 42, 59);
  check("warp: a much smaller page still reads (shrunk first)", tiny.width === 42 && tiny.height === 59);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** A flat page (paper 230, ink 45) lit from one side, with a hard shadow over its bottom third. */
function litPage(width: number, height: number, diagonal = false): { img: RawImage; inkAt: (x: number, y: number) => boolean; nearInk: (x: number, y: number) => boolean } {
  const data = new Uint8ClampedArray(width * height * 4);
  const r = rng(5);
  const inkAt = (x: number, y: number) => ink((x + 0.5) / width, (y + 0.5) / height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = inkAt(x, y) ? 45 : 230;
      v *= 1 - 0.6 * (x / width);
      // A hard shadow: across the bottom third, or slanting across the page.
      if (diagonal ? x > width * 0.55 + (y - height / 2) * 0.3 : y > height * 0.66) v *= 0.5;
      v += (r() - 0.5) * 8;
      const o = (y * width + x) * 4;
      data[o] = v + 4;
      data[o + 1] = v;
      data[o + 2] = v - 4;
      data[o + 3] = 255;
    }
  }
  const nearInk = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (inkAt(x + dx, y + dy) !== inkAt(x, y)) return true;
    return false;
  };
  return { img: { data, width, height }, inkAt, nearInk };
}
{
  const { img, inkAt, nearInk } = litPage(600, 850);
  const bw = documentBw(img);
  let paper = 0;
  let paperWhite = 0;
  let inked = 0;
  let inkBlack = 0;
  let shadowPaper = 0;
  let shadowWhite = 0;
  const twoTone = bw.data.every((v, i) => (i % 4 === 3 ? v === 255 : v === 0 || v === 255));
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (nearInk(x, y)) continue;
      const white = bw.data[(y * img.width + x) * 4] === 255;
      if (inkAt(x, y)) {
        inked++;
        if (!white) inkBlack++;
      } else {
        paper++;
        if (white) paperWhite++;
        if (y > img.height * 0.7 && x > img.width * 0.6) {
          shadowPaper++;
          if (white) shadowWhite++;
        }
      }
    }
  }
  check("document: only black and white", twoTone);
  check("document: paper comes out white, in the light and the shadow (98%+)", paperWhite / paper > 0.98, { paper: paperWhite / paper });
  check("document: the darkest corner (shadow, far from the light) stays white", shadowWhite / shadowPaper > 0.97, { shadow: shadowWhite / shadowPaper });
  check("document: ink comes out black (95%+)", inkBlack / inked > 0.95, { ink: inkBlack / inked });
  // One threshold for the whole page can't do it: the test means something.
  const l = (i: number) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  let naiveWhite = 0;
  let naivePaper = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (!inkAt(x, y) && !nearInk(x, y)) (naivePaper++, l((y * img.width + x) * 4) > 115 && naiveWhite++);
  check("document: a single threshold would lose the shadowed paper (control)", naiveWhite / naivePaper < 0.9, { naive: naiveWhite / naivePaper });

  // A slanting shadow edge, as a hand or a phone casts: no dark band along it.
  const slant = litPage(600, 850, true);
  const sbw = documentBw(slant.img);
  let nearEdge = 0;
  let nearEdgeWhite = 0;
  for (let y = 0; y < 850; y++) {
    const ex = Math.round(600 * 0.55 + (y - 425) * 0.3);
    for (let x = ex - 12; x <= ex + 12; x++) {
      if (x < 0 || x >= 600 || slant.inkAt(x, y) || slant.nearInk(x, y)) continue;
      nearEdge++;
      if (sbw.data[(y * 600 + x) * 4] === 255) nearEdgeWhite++;
    }
  }
  check("document: paper either side of a slanting shadow's edge stays white (97%+)", nearEdgeWhite / nearEdge > 0.97, { white: nearEdgeWhite / nearEdge });

  const g = grayscale(img);
  check("greyscale: equal channels, the pixel's brightness", g.data[0] === g.data[1] && g.data[1] === g.data[2] && Math.abs(g.data[0] - Math.round(0.299 * img.data[0] + 0.587 * img.data[1] + 0.114 * img.data[2])) <= 1);
  check("colour: as photographed", applyFilter(img, "color") === img);

  const t: RawImage = { width: 3, height: 2, data: new Uint8ClampedArray(24) };
  // Pixel values 1..6 in the red channel, row by row.
  for (let i = 0; i < 6; i++) (t.data[i * 4] = i + 1), (t.data[i * 4 + 3] = 255);
  const red = (img: RawImage) => Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4]);
  check("turn right: 3x2 becomes 2x3, top-left goes top-right", (() => { const r = turn(t, 90); return r.width === 2 && r.height === 3 && JSON.stringify(red(r)) === "[4,1,5,2,6,3]"; })(), red(turn(t, 90)));
  check("turn 180: reversed", JSON.stringify(red(turn(t, 180))) === "[6,5,4,3,2,1]");
  check("turn left: top-left goes bottom-left", JSON.stringify(red(turn(t, 270))) === "[3,6,2,5,1,4]" && JSON.stringify(red(turn(t, -90))) === "[3,6,2,5,1,4]");
  check("four turns: as it was", JSON.stringify(red(turn(turn(turn(turn(t, 90), 90), 90), 90))) === JSON.stringify(red(t)));
}

// ---------------------------------------------------------------------------
// Whole PDFs
// ---------------------------------------------------------------------------

/** The image XObjects of each page, in page order. */
async function pageImages(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const xo = page.node.Resources()?.lookup(PDFName.of("XObject"));
    const out: { width: number; height: number; filter: string; bits: number; space: string }[] = [];
    if (!xo || !("entries" in xo)) return out;
    for (const [, ref] of (xo as unknown as { entries(): [unknown, unknown][] }).entries()) {
      const obj = doc.context.lookup(ref as never);
      if (!(obj instanceof PDFRawStream)) continue;
      const n = (k: string) => (obj.dict.get(PDFName.of(k)) as PDFNumber | undefined)?.asNumber() ?? 0;
      out.push({ width: n("Width"), height: n("Height"), filter: String(obj.dict.get(PDFName.of("Filter"))), bits: n("BitsPerComponent"), space: String(obj.dict.get(PDFName.of("ColorSpace"))) });
    }
    return out;
  });
}

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
let canvasMod: typeof import("canvas") | null = null;
try {
  canvasMod = await import("canvas");
} catch {
  canvasMod = null;
}
/** pdf.js's picture of a page; null without node-canvas. */
async function render(bytes: Uint8Array, pageNo: number) {
  if (!canvasMod) return null;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 0.5 });
  const canvas = canvasMod.createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  await doc.destroy();
  return { width: canvas.width, height: canvas.height, at: (x: number, y: number) => data[(Math.floor(y) * canvas.width + Math.floor(x)) * 4 + 1] };
}

{
  // An A4 sheet as a camera sees it (a true perspective, not just a trapezoid).
  const scene: Scene = { width: 1000, height: 750, paper: camera(0.21, 0.297, 0.35, 0.1, 0.3, 1100, 0.6, 1000, 750), clutter: 25, falloff: 0.4, seed: 31 };
  const photo = drawScene(scene);
  const quad = geo.toFractions(scene.paper, photo.width, photo.height);
  // The same photo as the camera saves it: a JPEG.
  const jpeg = await codec.encodeJpeg(photo, { quality: 90 });
  const wide = drawScene({ width: 1000, height: 750, paper: sheet(500, 375, 600, 400, -0.1, 0.05), seed: 32 });
  const wideQuad = geo.toFractions(sheet(500, 375, 600, 400, -0.1, 0.05), 1000, 750);
  const pages = [
    { image: jpeg, quad, filter: "color" as const, rotation: 0 },
    { image: photo, quad, filter: "gray" as const, rotation: 0 },
    { image: photo, quad, filter: "bw" as const, rotation: 0 },
    { image: wide, quad: wideQuad, filter: "bw" as const, rotation: 90 },
  ];
  const labels: string[] = [];
  const fit = await buildScanPdf(pages, { pageSize: "fit" }, (_f, label) => labels.push(label));
  const doc = await PDFDocument.load(fit);
  const sizes = doc.getPages().map((p) => p.getSize());
  check("fit: one page per scan, in order", doc.getPageCount() === 4);
  check("fit: A4-shaped paper makes an A4-sized page", Math.abs(sizes[0].height - 841.89) < 0.5 && Math.abs(sizes[0].width / sizes[0].height - 210 / 297) < 0.02, sizes[0]);
  check("fit: a wide sheet turned right makes a tall page", sizes[3].height > sizes[3].width && Math.abs(sizes[3].width / sizes[3].height - 400 / 600) < 0.03, sizes[3]);
  check("progress names each page", labels.includes("Page 1 of 4") && labels.includes("Page 4 of 4"), labels);
  const imgs = await pageImages(fit);
  check("colour page: a colour JPEG", imgs[0].length === 1 && imgs[0][0].filter === "/DCTDecode" && imgs[0][0].space === "/DeviceRGB", imgs[0]);
  check("grey page: a one-channel JPEG", imgs[1][0]?.filter === "/DCTDecode" && imgs[1][0].space === "/DeviceGray", imgs[1]);
  check("document page: lossless, one bit a pixel", imgs[2][0]?.filter === "/FlateDecode" && imgs[2][0].bits === 1, imgs[2]);
  // A small photo: no more pixels than the photo has across the paper.
  const covered = geo.polygonArea(scene.paper);
  check("a small photo isn't blown up: no more pixels than the paper covers", [0, 1, 2].every((i) => imgs[i][0].width * imgs[i][0].height <= covered * 1.02), { covered, imgs: imgs.map((i) => i[0]) });

  const r = await render(fit, 3);
  if (r) {
    // Page 3 (Document): margin white, a text row dark somewhere along it.
    const margin = r.at(r.width * 0.04, r.height * 0.5);
    let darkInRow = 0;
    const rowY = r.height * (0.1 + 0.04 * 3 + 0.01);
    for (let x = r.width * 0.12; x < r.width * 0.88; x++) if (r.at(x, rowY) < 100) darkInRow++;
    check("pdf.js shows the document page: white margin, dark text row", margin > 200 && darkInRow > r.width * 0.2, { margin, darkInRow });
  } else {
    console.log("SKIP  rendering checks (no node-canvas)");
  }

  const a4 = await PDFDocument.load(await buildScanPdf(pages, { pageSize: "a4" }));
  const a4Sizes = a4.getPages().map((p) => p.getSize());
  check("A4: every page 595 x 842, upright", a4Sizes.every((s) => Math.round(s.width) === 595 && Math.round(s.height) === 842), a4Sizes);
  const letterDoc = await PDFDocument.load(await buildScanPdf([pages[0], { image: wide, quad: wideQuad, filter: "color" as const, rotation: 0 }], { pageSize: "letter" }));
  const ls = letterDoc.getPages().map((p) => p.getSize());
  check("Letter: 612 x 792; a wide scan gets a landscape sheet", Math.round(ls[0].width) === 612 && Math.round(ls[0].height) === 792 && Math.round(ls[1].width) === 792 && Math.round(ls[1].height) === 612, ls);

  // Many pages: small photos, all there, in order (told apart by shape).
  const many = Array.from({ length: 24 }, (_, i) => {
    const w = 120 + i * 4;
    const small: RawImage = { width: w, height: 160, data: new Uint8ClampedArray(w * 160 * 4).fill(220) };
    return { image: small, quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] as Quad, filter: "gray" as const, rotation: 0 };
  });
  const t0 = performance.now();
  const manyDoc = await PDFDocument.load(await buildScanPdf(many, { pageSize: "fit" }));
  const ratios = manyDoc.getPages().map((p) => p.getSize().width / p.getSize().height);
  check("24 pages: all there, in the order given", manyDoc.getPageCount() === 24 && ratios.every((r, i) => i === 0 || r > ratios[i - 1]), { n: manyDoc.getPageCount(), ms: Math.round(performance.now() - t0) });

  const broken = await settle(buildScanPdf([pages[0], { image: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), quad, filter: "color", rotation: 0 }], { pageSize: "fit" }));
  check("a photo that can't be read: says which page", broken.error?.message === "Page 2: this photo couldn't be read. Take it again.", broken.error?.message);
  const none = await settle(buildScanPdf([], { pageSize: "fit" }));
  check("no pages: says so", none.error?.message === "Scan or add a page first.", none.error?.message);
  const folded = await settle(buildScanPdf([{ image: photo, quad: [quad[0], quad[2], quad[1], quad[3]], filter: "color", rotation: 0 }], { pageSize: "fit" }));
  check("crossed corners: says how to fix them", /cross over/.test(folded.error?.message ?? ""), folded.error?.message);
  const ctl = new AbortController();
  const stopped = await settle(buildScanPdf(pages, { pageSize: "fit" }, (_f, label) => label === "Page 2 of 4" && ctl.abort(), ctl.signal));
  check("cancel stops it between pages", stopped.error?.name === "AbortError", stopped.error?.name);

  // A sharp photo, flat on: 200 DPI for colour and grey, 300 for Document, not more.
  const big: RawImage = { width: 3000, height: 4243, data: new Uint8ClampedArray(3000 * 4243 * 4) };
  for (let y = 0; y < big.height; y++) for (let x = 0; x < big.width; x++) {
    const o = (y * big.width + x) * 4;
    big.data[o] = big.data[o + 1] = big.data[o + 2] = ink((x + 0.5) / big.width, (y + 0.5) / big.height) ? 40 : 235;
    big.data[o + 3] = 255;
  }
  const whole: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const sharp = await buildScanPdf([{ image: big, quad: whole, filter: "color", rotation: 0 }, { image: big, quad: whole, filter: "bw", rotation: 0 }], { pageSize: "a4" });
  const sharpImgs = await pageImages(sharp);
  const dpiOf = (i: number) => Math.round(sharpImgs[i][0].height / (841.89 / 72));
  check("a sharp photo: colour at 200 DPI, Document at 300 DPI", dpiOf(0) === 200 && dpiOf(1) === 300, { color: dpiOf(0), bw: dpiOf(1) });
  check("a sharp page stays small: under 1.5 MB for two A4 pages", sharp.length < 1.5e6, sharp.length);

  // flattenPage keeps to the size asked for.
  const thumb = flattenPage(photo, { quad, filter: "bw", rotation: 270 }, 360);
  check("thumbnail: long side 360, turned on its side", Math.max(thumb.width, thumb.height) === 360 && thumb.width > thumb.height, { w: thumb.width, h: thumb.height });

  // Searchable: the OCR PDF tool's text layer laid over the scan (the reader is a stand-in for Tesseract here).
  const { scanToPdf, scanName } = await import("../lib/pdf/scan/run.ts");
  const reads: string[] = [];
  const reader = async (bytes: Uint8Array, lang: string) => {
    reads.push(lang);
    const d = await PDFDocument.load(bytes);
    return d.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { widthPt: width, heightPt: height, imageWidth: 1000, imageHeight: 1414, words: [{ text: "Invoice", x0: 100, y0: 100, x1: 300, y1: 140, confidence: 90 }, { text: "2026", x0: 320, y0: 100, x1: 420, y1: 140, confidence: 88 }] };
    });
  };
  const progress: number[] = [];
  const out = await scanToPdf(pages.slice(0, 2), { pageSize: "a4", ocr: "deu" }, { progress: (f) => progress.push(f) }, reader);
  check("searchable: read in the language picked, words counted", reads[0] === "deu" && out.words === 4 && out.pages === 2, { reads, words: out.words });
  const text = await (async () => {
    const d = await pdfjs.getDocument({ data: out.bytes.slice(), isEvalSupported: false }).promise;
    const t = await (await d.getPage(2)).getTextContent();
    await d.destroy();
    return t.items.map((i) => ("str" in i ? i.str : "")).join("");
  })();
  check("searchable: pdf.js finds the text on the page", /Invoice\s*2026/.test(text), text);
  check("searchable: progress only goes forward, to the end", progress.every((f, i) => i === 0 || f >= progress[i - 1] - 1e-9) && progress[progress.length - 1] === 1, progress);
  const blank = await scanToPdf(pages.slice(0, 1), { pageSize: "fit", ocr: "eng" }, {}, async (bytes) => (await PDFDocument.load(bytes)).getPages().map(() => null));
  check("searchable but nothing legible: the scan as it is, 0 words", blank.words === 0 && (await PDFDocument.load(blank.bytes)).getPageCount() === 1);
  const plain = await scanToPdf(pages.slice(0, 1), { pageSize: "fit", ocr: null }, {}, async () => {
    throw new Error("not called");
  });
  check("not searchable: no reading at all", plain.words === null);
  check("file name from the date", scanName(new Date(2026, 0, 5)) === "scan-2026-01-05.pdf");
}

// ---------------------------------------------------------------------------
// The camera's messages
// ---------------------------------------------------------------------------
{
  const { cameraProblem, canUseCamera } = await import("../lib/pdf/scan/camera.ts");
  const err = (name: string) => Object.assign(new Error("x"), { name });
  check("refused: says how to allow it, and the way round", /Allow it in your browser's settings, or take a photo instead\./.test(cameraProblem(err("NotAllowedError")).message));
  check("refused: the camera app from then on; busy: the camera can be tried again", cameraProblem(err("NotAllowedError")).refused === true && !cameraProblem(err("NotReadableError")).refused && !cameraProblem(err("NotReadableError")).noCamera);
  check("refused on a computer: choose photos instead", /or choose photos instead\./.test(cameraProblem(new DOMException("x", "NotAllowedError"), false).message));
  check("no camera: not offered again", cameraProblem(err("NotFoundError")).noCamera === true && cameraProblem(err("OverconstrainedError"), false).message === "No camera found. Choose photos instead.");
  check("busy: says another app has it", /busy in another app/.test(cameraProblem(err("NotReadableError")).message));
  check("anything else: a plain retry", cameraProblem("odd").message === "The camera didn't start. Try again, or take a photo instead.");
  check("no getUserMedia (an in-app browser): the camera isn't offered", !canUseCamera({}) && !canUseCamera(undefined) && canUseCamera({ mediaDevices: { getUserMedia: async () => ({}) } } as unknown as Navigator));
}

// ---------------------------------------------------------------------------
// Registered, found, and the only page that may use the camera
// ---------------------------------------------------------------------------
{
  const { TOOLS, getTool, relatedTools } = await import("../lib/tools.tsx");
  const { filterTools } = await import("../components/tool-filter.ts");
  const { panelSpec } = await import("../components/tools/panel-spec.tsx");
  const tool = getTool("scan-to-pdf");
  check("registered once, under Convert, with its own panel", !!tool && tool.category === "convert" && TOOLS.filter((t) => t.slug === "scan-to-pdf").length === 1 && panelSpec(tool).kind === "scan");
  check("search finds it by what people type", ["scan", "scanner", "document scanner", "camera", "pdf scanner", "receipt", "scan to pdf"].every((q) => filterTools(TOOLS, "all", q).some((t) => t.slug === "scan-to-pdf")));
  check("more tools: OCR first", relatedTools("scan-to-pdf")[0]?.slug === "ocr-pdf" && relatedTools("scan-to-pdf").length === 4);
  const sitemap = (await import("../app/sitemap.ts")).default();
  check("in the sitemap", sitemap.some((e) => e.url.endsWith("/tools/scan-to-pdf")));
  const page = readFileSync("app/tools/[slug]/page.tsx", "utf8");
  check("the page shows its how-it-works and questions", page.includes('tool.slug === "scan-to-pdf" && <ScanAbout />'));

  const { CAMERA_PAGES, permissionsPolicy } = await import("../lib/permissions-policy.ts");
  const config = (await import("../next.config.ts")).default("phase-development-server");
  const rules = await config.headers!();
  const { getPathMatch } = await import("next/dist/shared/lib/router/utils/path-match.js");
  /** The Permissions-Policy a page gets: the last rule that sets it wins, as Next applies them. */
  const policyFor = (path: string) => {
    let value: string | undefined;
    for (const rule of rules) {
      if (!getPathMatch(rule.source)(path)) continue;
      const h = rule.headers.find((x) => x.key.toLowerCase() === "permissions-policy");
      if (h) value = h.value;
    }
    return value;
  };
  check("camera allowed, for this site only, on Scan to PDF", policyFor("/tools/scan-to-pdf") === "camera=(self), microphone=(), geolocation=()", policyFor("/tools/scan-to-pdf"));
  check("camera off everywhere else", ["/", "/tools", "/tools/jpg-to-pdf", "/tools/scan-to-pdf-extra", "/edit/abc", "/dashboard", "/api/prices", "/vendor/x.js"].every((p) => policyFor(p) === "camera=(), microphone=(), geolocation=()"), ["/", "/tools/jpg-to-pdf", "/tools/scan-to-pdf-extra"].map(policyFor));
  check("microphone and location never allowed", !permissionsPolicy(true).includes("microphone=(self)") && CAMERA_PAGES.length === 1);
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
