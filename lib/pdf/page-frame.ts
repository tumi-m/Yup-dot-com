import type { PDFPage } from "pdf-lib";

/**
 * The page as the reader sees it: visible box (CropBox, which defaults to the
 * MediaBox) with /Rotate applied. Stamps such as page numbers and watermarks
 * are laid out in this frame, then mapped back to PDF user space — otherwise
 * they land off-page on boxes that don't start at 0,0 and sideways on
 * rotated pages.
 */
export interface PageFrame {
  /** Displayed width and height. */
  width: number;
  height: number;
  /** Page /Rotate, normalised to 0, 90, 180 or 270 (clockwise). */
  rotation: number;
  /** Maps a displayed point (from the bottom-left) to user space. */
  toPdf: (u: number, v: number) => { x: number; y: number };
  /** Inverse of `toPdf`: a user-space point on the displayed page. */
  toDisplay: (x: number, y: number) => { u: number; v: number };
  /** Converts a displayed text angle (degrees, counter-clockwise) to user space. */
  angle: (displayDegrees: number) => number;
  /** `toPdf` as a matrix (a b c d e f), for drawing a whole block in displayed coordinates. */
  matrix: [number, number, number, number, number, number];
}

/**
 * The area pdf.js renders: the CropBox clipped to the MediaBox (they are
 * the same on nearly every PDF).
 */
export function visibleBox(page: PDFPage): { x: number; y: number; width: number; height: number } {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const x0 = Math.max(Math.min(crop.x, crop.x + crop.width), Math.min(media.x, media.x + media.width));
  const y0 = Math.max(Math.min(crop.y, crop.y + crop.height), Math.min(media.y, media.y + media.height));
  const x1 = Math.min(Math.max(crop.x, crop.x + crop.width), Math.max(media.x, media.x + media.width));
  const y1 = Math.min(Math.max(crop.y, crop.y + crop.height), Math.max(media.y, media.y + media.height));
  if (x1 <= x0 || y1 <= y0) return media;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function pageFrame(page: PDFPage, box = page.getCropBox()): PageFrame {
  const r = (((Math.round(page.getRotation().angle / 90) * 90) % 360) + 360) % 360;
  const { x: bx, y: by, width: W, height: H } = box;
  const swap = r === 90 || r === 270;
  const toPdf = (u: number, v: number) => {
    switch (r) {
      case 90:
        return { x: bx + W - v, y: by + u };
      case 180:
        return { x: bx + W - u, y: by + H - v };
      case 270:
        return { x: bx + v, y: by + H - u };
      default:
        return { x: bx + u, y: by + v };
    }
  };
  const toDisplay = (x: number, y: number) => {
    switch (r) {
      case 90:
        return { u: y - by, v: bx + W - x };
      case 180:
        return { u: bx + W - x, v: by + H - y };
      case 270:
        return { u: by + H - y, v: x - bx };
      default:
        return { u: x - bx, v: y - by };
    }
  };
  const matrix: PageFrame["matrix"] =
    r === 90
      ? [0, 1, -1, 0, bx + W, by]
      : r === 180
        ? [-1, 0, 0, -1, bx + W, by + H]
        : r === 270
          ? [0, -1, 1, 0, bx, by + H]
          : [1, 0, 0, 1, bx, by];
  return {
    width: swap ? H : W,
    height: swap ? W : H,
    rotation: r,
    toPdf,
    toDisplay,
    angle: (d) => (d + r) % 360,
    matrix,
  };
}
