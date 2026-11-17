/**
 * The box around the ink in an RGBA picture (alpha above a faint threshold),
 * grown by `pad` pixels and kept inside the picture. Null when there is no ink.
 */
export function inkBounds(
  data: ArrayLike<number>,
  width: number,
  height: number,
  pad = 4
): { x: number; y: number; width: number; height: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return {
    x,
    y,
    width: Math.min(width, maxX + 1 + pad) - x,
    height: Math.min(height, maxY + 1 + pad) - y,
  };
}
