/**
 * One scanned page as the person set it up: the photo, the paper's corners,
 * the filter and the turn; and the page flattened from them. Light enough to
 * load with the tool's page (the editor's preview and the tray's pictures use
 * it); the PDF itself is made in build.ts.
 *
 * No browser APIs: unit-tested in Node, and run in a worker in the browser.
 */
import type { RawImage } from "../../image-codec";
import { flatSize, isConvex, type Quad } from "./geometry";
import { applyFilter, turn, type ScanFilter } from "./filters";
import { warpQuad } from "./warp";

export type ScanPageSize = "fit" | "a4" | "letter";

export const PAGE_SIZES: { value: ScanPageSize; label: string }[] = [
  { value: "fit", label: "Fit" },
  { value: "a4", label: "A4" },
  { value: "letter", label: "Letter" },
];

export interface ScanPage {
  /** The photo: JPEG bytes (as captured), or its pixels. */
  image: Blob | Uint8Array | RawImage;
  /** The paper's corners, in fractions of the photo. */
  quad: Quad;
  filter: ScanFilter;
  /** Clockwise, in degrees: 0, 90, 180 or 270. */
  rotation: number;
}

export interface ScanOptions {
  pageSize: ScanPageSize;
}

/** The long side a flattened page never goes past: A4 at 300 DPI. */
export const MAX_LONG = 3508;

/**
 * The flattened, filtered and turned page, its long side at most `maxLong`
 * pixels (and never more than the photo has across the paper).
 */
export function flattenPage(photo: RawImage, page: Omit<ScanPage, "image">, maxLong = MAX_LONG): RawImage {
  if (!isConvex(page.quad)) throw new Error("These corners cross over. Drag them to the corners of the page.");
  const size = flatSize(page.quad, photo.width, photo.height, Math.min(MAX_LONG, maxLong));
  return turn(applyFilter(warpQuad(photo, page.quad, size.width, size.height), page.filter), page.rotation);
}
