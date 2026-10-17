import type { RawImage } from "./image-codec";

/**
 * Image sizing for exports: how many pixels an image needs where it is shown,
 * and a good-quality downscaler (area averaging) that runs anywhere, without
 * a canvas, so Node tests and the browser give the same pixels.
 */

/** Print resolution: more pixels than this per inch on paper can't be seen. */
const PRINT_DPI = 300;

/**
 * Pixel size for a `width`×`height` image shown at `shownWidthPt`×`shownHeightPt`
 * points, so it lands at `dpi`; null when it is already at or below that
 * (with a little slack: shaving off a few pixels isn't worth a re-encode).
 */
export function downsampleTarget(
  width: number,
  height: number,
  shownWidthPt: number,
  shownHeightPt: number,
  dpi = PRINT_DPI
): { width: number; height: number } | null {
  if (width <= 0 || height <= 0 || shownWidthPt <= 0 || shownHeightPt <= 0) return null;
  // The larger of the two keeps both directions at `dpi` or above.
  const scale = Math.max(((shownWidthPt / 72) * dpi) / width, ((shownHeightPt / 72) * dpi) / height);
  if (scale > 0.92) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const SCREEN_1080P = { long: 1920, short: 1080 };

/**
 * Pixels per point that fit a `width`×`height` pt page in `screen`, turned
 * to match the page (a portrait slide gets 1080×1920 to fit in).
 */
export function screenRatio(width: number, height: number, screen = SCREEN_1080P): number {
  const [long, short] = width >= height ? [width, height] : [height, width];
  return Math.min(screen.long / long, screen.short / short);
}

/** For each output pixel, the input pixels it covers and how much of each. */
function spans(from: number, to: number) {
  const step = from / to;
  const first = new Int32Array(to);
  const weights: Float32Array[] = [];
  for (let i = 0; i < to; i++) {
    const start = i * step;
    const end = Math.min(from, (i + 1) * step);
    const a = Math.floor(start);
    const b = Math.min(from, Math.ceil(end));
    const w = new Float32Array(b - a);
    for (let k = a; k < b; k++) w[k - a] = (Math.min(end, k + 1) - Math.max(start, k)) / (end - start);
    first[i] = a;
    weights.push(w);
  }
  return { first, weights };
}

/**
 * Shrinks RGBA pixels to `width`×`height` by averaging the area each output
 * pixel covers (sharp and alias-free for any factor). Colour is weighted by
 * alpha, so transparent pixels don't bleed into their neighbours. Only
 * downscales: a larger target is clamped to the source size.
 */
export function resizeRgba(src: RawImage, width: number, height: number): RawImage {
  const sw = src.width;
  const sh = src.height;
  width = Math.max(1, Math.min(sw, Math.round(width)));
  height = Math.max(1, Math.min(sh, Math.round(height)));
  if (width === sw && height === sh) return src;
  const d = src.data;
  let opaque = true;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const xs = spans(sw, width);
  const ys = spans(sh, height);
  const out = new Uint8ClampedArray(width * height * 4);
  const row = new Float32Array(width * 4);
  const acc = new Float32Array(width * 4);
  let cachedRow = -1;

  const resampleRow = (sy: number) => {
    if (sy === cachedRow) return;
    cachedRow = sy;
    const base = sy * sw * 4;
    for (let x = 0; x < width; x++) {
      const w = xs.weights[x];
      let p = base + xs.first[x] * 4;
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < w.length; k++, p += 4) {
        const wk = w[k];
        if (opaque) {
          r += d[p] * wk;
          g += d[p + 1] * wk;
          b += d[p + 2] * wk;
        } else {
          const wa = wk * d[p + 3];
          r += d[p] * wa;
          g += d[p + 1] * wa;
          b += d[p + 2] * wa;
          a += wa;
        }
      }
      const o = x * 4;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      row[o + 3] = opaque ? 255 : a;
    }
  };

  for (let y = 0; y < height; y++) {
    acc.fill(0);
    const w = ys.weights[y];
    for (let k = 0; k < w.length; k++) {
      resampleRow(ys.first[y] + k);
      const wk = w[k];
      for (let i = 0; i < acc.length; i++) acc[i] += row[i] * wk;
    }
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      if (opaque) {
        out[o + i] = acc[i];
        out[o + i + 1] = acc[i + 1];
        out[o + i + 2] = acc[i + 2];
        out[o + i + 3] = 255;
      } else {
        // acc holds alpha-weighted sums: divide by the summed alpha.
        const a = acc[i + 3];
        out[o + i] = a > 0 ? acc[i] / a : 0;
        out[o + i + 1] = a > 0 ? acc[i + 1] / a : 0;
        out[o + i + 2] = a > 0 ? acc[i + 2] / a : 0;
        out[o + i + 3] = a;
      }
    }
  }
  return { data: out, width, height };
}
