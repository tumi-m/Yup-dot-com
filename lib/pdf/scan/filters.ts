/**
 * What a flattened page looks like in the PDF: as photographed, grey, or
 * "document" black and white; and turning it a quarter at a time.
 *
 * Document mode first works out how bright the paper is under each part of
 * the page (paperLevel), and divides it out, so a shadow or a lamp to one
 * side leaves the paper white. Ink is then whatever is clearly darker than
 * its own paper.
 *
 * No browser APIs: unit-tested in Node, and run in a worker in the browser.
 */
import type { RawImage } from "../../image-codec";

export type ScanFilter = "color" | "gray" | "bw";

export const FILTERS: { value: ScanFilter; label: string }[] = [
  { value: "color", label: "Colour" },
  { value: "gray", label: "Greyscale" },
  { value: "bw", label: "Document" },
];

export const isFilter = (v: unknown): v is ScanFilter => v === "color" || v === "gray" || v === "bw";

/** Rec. 601 brightness of each pixel. */
function luma(img: RawImage): Float32Array {
  const d = img.data;
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  return out;
}

function fromGray(values: Float32Array | Uint8Array, width: number, height: number): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    data[p] = data[p + 1] = data[p + 2] = values[i];
    data[p + 3] = 255;
  }
  return { data, width, height };
}

/**
 * The largest (or smallest) value in a window of `k` along each line, for
 * every pixel: van Herk and Gil-Werman's method, three comparisons a pixel
 * whatever the window's size. `step` is 1 along rows, the width down columns.
 */
function slide(src: Float32Array, lines: number, len: number, lineStep: number, step: number, k: number, max: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const r = k >> 1;
  const fwd = new Float32Array(len + k);
  const bwd = new Float32Array(len + k);
  const pick = max ? Math.max : Math.min;
  const edge = max ? -Infinity : Infinity;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    // Padded by r on each side, so the window never runs off the line.
    const n = len + 2 * r;
    const at = (i: number) => (i < r || i >= len + r ? edge : src[base + (i - r) * step]);
    for (let i = 0; i < n; i++) fwd[i] = i % k === 0 ? at(i) : pick(fwd[i - 1], at(i));
    for (let i = n - 1; i >= 0; i--) bwd[i] = i === n - 1 || (i + 1) % k === 0 ? at(i) : pick(bwd[i + 1], at(i));
    for (let i = 0; i < len; i++) out[base + i * step] = pick(bwd[i], fwd[Math.min(n - 1, i + 2 * r)]);
  }
  return out;
}

/** A square max (or min) filter of side k. */
function square(src: Float32Array, width: number, height: number, k: number, max: boolean): Float32Array {
  const rows = slide(src, height, width, width, 1, k, max);
  return slide(rows, width, height, 1, width, k, max);
}

/**
 * How bright the paper is under each pixel: a closing (the brightest pixel
 * near each one, then the darkest of those), with a window wider than a pen
 * stroke. Writing disappears from it, but the edge of a shadow stays exactly
 * where it is, so paper on either side of it is judged against its own light.
 */
export function paperLevel(l: Float32Array, width: number, height: number): Float32Array {
  const k = Math.max(5, Math.round(Math.max(width, height) / 60)) | 1;
  return square(square(l, width, height, k, true), width, height, k, false);
}

/** Ink at or below this share of its paper's brightness turns black. */
const INK = 0.72;

/** Black and white, like a photocopy: shadows and uneven light are divided out first. */
export function documentBw(img: RawImage): RawImage {
  const { width, height } = img;
  const l = luma(img);
  const paper = paperLevel(l, width, height);
  const out = new Uint8Array(l.length);
  for (let i = 0; i < l.length; i++) {
    // A floor, so the noise in a very dark corner isn't stretched into speckles.
    const p = Math.max(24, paper[i]);
    out[i] = l[i] / p > INK ? 255 : 0;
  }
  return fromGray(out, width, height);
}

export function grayscale(img: RawImage): RawImage {
  return fromGray(luma(img), img.width, img.height);
}

export function applyFilter(img: RawImage, filter: ScanFilter): RawImage {
  if (filter === "gray") return grayscale(img);
  if (filter === "bw") return documentBw(img);
  return img;
}

/** Quarter turns clockwise: 0, 90, 180 or 270 degrees. */
export function turn(img: RawImage, degrees: number): RawImage {
  const q = (((Math.round(degrees / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  if (!q) return img;
  const { width: w, height: h, data: s } = img;
  const ow = q === 2 ? w : h;
  const oh = q === 2 ? h : w;
  const out = new Uint8ClampedArray(s.length);
  const d32 = new Uint32Array(out.buffer);
  // Whole pixels at a time; a view needs its start on a 4-byte boundary.
  const s32 = new Uint32Array((s.byteOffset % 4 ? s.slice() : s).buffer, s.byteOffset % 4 ? 0 : s.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number, oy: number;
      if (q === 1) (ox = h - 1 - y), (oy = x);
      else if (q === 2) (ox = w - 1 - x), (oy = h - 1 - y);
      else (ox = y), (oy = w - 1 - x);
      d32[oy * ow + ox] = s32[y * w + x];
    }
  }
  return { data: out, width: ow, height: oh };
}
