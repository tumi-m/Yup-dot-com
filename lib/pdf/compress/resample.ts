/**
 * Downscaling for 8-bit interleaved pixels (1, 3 or 4 channels) in two
 * separable passes. Each new pixel is the exact average of the source area it
 * covers, fractional edge pixels included. (A Catmull-Rom filter measured no
 * better in size for the quality, and rings at hard edges.)
 */

interface Weights {
  start: Int32Array;
  count: Int32Array;
  /** `taps` weights per output pixel. */
  w: Float32Array;
  taps: number;
}

function weights(inSize: number, outSize: number): Weights {
  const scale = inSize / outSize;
  const taps = Math.ceil(scale) + 1;
  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const w = new Float32Array(outSize * taps);
  for (let o = 0; o < outSize; o++) {
    const lo = o * scale;
    const hi = Math.min(inSize, lo + scale);
    let n = 0;
    let total = 0;
    for (let i = Math.floor(lo); i < hi && n < taps; i++) {
      const v = Math.min(hi, i + 1) - Math.max(lo, i);
      w[o * taps + n++] = v;
      total += v;
    }
    start[o] = Math.floor(lo);
    count[o] = n;
    for (let k = 0; k < n; k++) w[o * taps + k] /= total;
  }
  return { start, count, w, taps };
}

/** Resizes `src` (w×h, `ch` channels) to nw×nh. */
export function resize(
  src: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  ch: number,
  nw: number,
  nh: number
): Uint8Array {
  let data: Uint8Array | Uint8ClampedArray = src;
  let cw = w;
  if (nw !== w) {
    const k = weights(w, nw);
    const out = new Uint8Array(nw * h * ch);
    const acc = new Float64Array(ch);
    for (let y = 0; y < h; y++) {
      const row = y * w * ch;
      const orow = y * nw * ch;
      for (let x = 0; x < nw; x++) {
        acc.fill(0);
        const base = x * k.taps;
        const s = k.start[x];
        for (let t = 0; t < k.count[x]; t++) {
          const wt = k.w[base + t];
          const p = row + (s + t) * ch;
          for (let c = 0; c < ch; c++) acc[c] += data[p + c] * wt;
        }
        for (let c = 0; c < ch; c++) {
          const v = Math.round(acc[c]);
          out[orow + x * ch + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
    data = out;
    cw = nw;
  }
  if (nh === h) return data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length);
  const k = weights(h, nh);
  const stride = cw * ch;
  const out = new Uint8Array(nh * stride);
  const acc = new Float64Array(stride);
  for (let y = 0; y < nh; y++) {
    acc.fill(0);
    const base = y * k.taps;
    const s = k.start[y];
    for (let t = 0; t < k.count[y]; t++) {
      const wt = k.w[base + t];
      const row = (s + t) * stride;
      for (let i = 0; i < stride; i++) acc[i] += data[row + i] * wt;
    }
    const orow = y * stride;
    for (let i = 0; i < stride; i++) {
      const v = Math.round(acc[i]);
      out[orow + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}
