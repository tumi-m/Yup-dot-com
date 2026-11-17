// A signature is placed as the ink, not the whole pad: a small signature in
// a corner of the pad used to shrink to a speck inside the placed box. A pad
// with no ink gives nothing to place.
import { inkBounds } from "../lib/editor/signature.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const W = 460;
const H = 180;
const pad = new Uint8ClampedArray(W * H * 4);
check("an empty pad has no ink", inkBounds(pad, W, H) === null);

// Ink from (100, 50) to (159, 69).
for (let y = 50; y < 70; y++) for (let x = 100; x < 160; x++) pad[(y * W + x) * 4 + 3] = 255;
const box = inkBounds(pad, W, H, 4);
check("the box is the ink plus padding", JSON.stringify(box) === JSON.stringify({ x: 96, y: 46, width: 68, height: 28 }), box);

// Faint anti-aliasing alone doesn't count as ink.
const faint = new Uint8ClampedArray(W * H * 4);
faint[(10 * W + 10) * 4 + 3] = 5;
check("near-transparent pixels are not ink", inkBounds(faint, W, H) === null);

// Ink at the edge: the padding stays inside the pad.
const edge = new Uint8ClampedArray(W * H * 4);
edge[3] = 255;
edge[((H - 1) * W + (W - 1)) * 4 + 3] = 255;
check("padding stays inside the pad", JSON.stringify(inkBounds(edge, W, H, 4)) === JSON.stringify({ x: 0, y: 0, width: W, height: H }), inkBounds(edge, W, H, 4));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
