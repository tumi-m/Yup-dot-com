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
}

export function pageFrame(page: PDFPage): PageFrame {
  const box = page.getCropBox();
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
  return {
    width: swap ? H : W,
    height: swap ? W : H,
    rotation: r,
    toPdf,
    toDisplay,
    angle: (d) => (d + r) % 360,
  };
}
