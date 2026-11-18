/**
 * How two drawn pages differ, pixel by pixel: the areas that changed, and a
 * picture of the difference for the Difference view. Plain numbers in and
 * out; the pages are drawn by the caller, both at the same scale.
 */

export interface PixelArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelDiff {
  /** Share of the pixels that differ, 0 to 1. */
  share: number;
  /** Areas that changed, in pixels, merged into boxes. */
  areas: PixelArea[];
}

/** Two pixels differ when their red, green and blue differ by more than this in all (anti-aliasing stays under it). */
const PIXEL_TOLERANCE = 96;
/** Changes are gathered in cells this many pixels across, so a changed word is one box, not a cloud of dots. */
const CELL = 8;
/** A cell with fewer changed pixels than this is noise. */
const CELL_MIN = 3;

const differs = (a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) =>
  Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > PIXEL_TOLERANCE;

/** The areas where two same-sized RGBA pictures differ. */
export function pixelDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number): PixelDiff {
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const counts = new Uint16Array(cols * rows);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / CELL) * cols;
    for (let x = 0; x < width; x++) {
      if (!differs(a, b, (y * width + x) * 4)) continue;
      changed++;
      counts[row + Math.floor(x / CELL)]++;
    }
  }
  // Neighbouring changed cells (diagonals too) make one area.
  const seen = new Uint8Array(cols * rows);
  const areas: PixelArea[] = [];
  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || counts[start] < CELL_MIN) continue;
    let [x0, y0, x1, y1] = [cols, rows, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cols;
      const cy = (c - cx) / cols;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const n = ny * cols + nx;
          if (!seen[n] && counts[n] >= CELL_MIN) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const x = x0 * CELL;
    const y = y0 * CELL;
    areas.push({ x, y, width: Math.min(width, (x1 + 1) * CELL) - x, height: Math.min(height, (y1 + 1) * CELL) - y });
  }
  return { share: width * height ? changed / (width * height) : 0, areas };
}

/** Dark enough to be ink. */
const inked = (p: Uint8ClampedArray, i: number) => p[i] + p[i + 1] + p[i + 2] < 600;

/**
 * The Difference view's picture: what is alike is drawn faint, ink only in
 * the original is red and striped, ink only in the changed version is green
 * and solid, and other changes (a colour) are purple. The stripes tell
 * removed from added without the colours.
 */
export function differencePicture(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i + 3] = 255;
      if (!differs(a, b, i)) {
        // Alike: a light grey copy of the page.
        const grey = (b[i] + b[i + 1] + b[i + 2]) / 3;
        const faint = 255 - (255 - grey) * 0.25;
        out[i] = out[i + 1] = out[i + 2] = faint;
        continue;
      }
      const inA = inked(a, i);
      const inB = inked(b, i);
      if (inA && !inB) {
        // Taken out: red, every other diagonal band left pale.
        const band = ((x + y) >> 2) % 2 === 0;
        out[i] = band ? 220 : 250;
        out[i + 1] = band ? 38 : 200;
        out[i + 2] = band ? 38 : 200;
      } else if (inB && !inA) {
        out[i] = 22;
        out[i + 1] = 150;
        out[i + 2] = 60;
      } else {
        out[i] = 150;
        out[i + 1] = 60;
        out[i + 2] = 200;
      }
    }
  }
  return out;
}
