/**
 * Flattens the paper in a photo: each pixel of the output rectangle is read
 * from where the perspective transform puts it in the photo (bilinear, so
 * edges stay smooth). A photo with many more pixels across the paper than
 * the output wants is shrunk first, by averaging, so fine print doesn't
 * shimmer. Turning and the colour filters are in filters.ts.
 *
 * No browser APIs: unit-tested in Node, and run in a worker in the browser.
 */
import type { RawImage } from "../../image-codec";
import { resizeRgba } from "../../image-fit";
import { homography, toPixels, type Quad } from "./geometry";

/** `quad` in fractions of the photo; the output is `width`×`height`, opaque. */
export function warpQuad(src: RawImage, quad: Quad, width: number, height: number): RawImage {
  // How many photo pixels each output pixel spans, along the paper's longer measure.
  const px = toPixels(quad, src.width, src.height);
  const across = Math.max(Math.hypot(px[1].x - px[0].x, px[1].y - px[0].y), Math.hypot(px[2].x - px[3].x, px[2].y - px[3].y));
  const down = Math.max(Math.hypot(px[3].x - px[0].x, px[3].y - px[0].y), Math.hypot(px[2].x - px[1].x, px[2].y - px[1].y));
  const shrink = Math.min(across / width, down / height);
  const photo = shrink > 1.5 ? resizeRgba(src, src.width / shrink, src.height / shrink) : src;
  const corners = toPixels(quad, photo.width, photo.height);
  const rect: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  // Output to photo: each output pixel looks up where it comes from.
  const h = homography(rect, corners);
  if (!h) throw new Error("These corners don't make a page. Move them apart.");
  const sw = photo.width;
  const sh = photo.height;
  const s = photo.data;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = y + 0.5;
    // Numerators and denominator grow linearly along a row.
    let nx = h[0] * 0.5 + h[1] * v + h[2];
    let ny = h[3] * 0.5 + h[4] * v + h[5];
    let dz = h[6] * 0.5 + h[7] * v + h[8];
    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const fx = nx / dz - 0.5;
      const fy = ny / dz - 0.5;
      nx += h[0];
      ny += h[3];
      dz += h[6];
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const ax = Math.max(0, Math.min(1, fx - x0));
      const ay = Math.max(0, Math.min(1, fy - y0));
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      out[o] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
      out[o + 1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
      out[o + 2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return { data: out, width, height };
}
