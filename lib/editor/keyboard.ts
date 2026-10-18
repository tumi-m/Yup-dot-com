import { annotationLabel, type Annotation } from "./types";

/** Smallest box a keyboard resize leaves, as with the resize handles. */
const MIN = 6;

const STEP: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** `v` kept inside [lo, hi], or where it already was if that was outside. */
function keepIn(v: number, from: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, Math.min(lo, from)), Math.max(hi, from));
}

/**
 * The keyboard version of dragging an annotation or its corner handle. Arrow
 * keys move it 1pt (10pt with Shift); with Alt they resize it from its
 * bottom-right corner (a line's end point) instead. It doesn't go further
 * off the page than it already is. Null for any other key.
 */
export function nudgeAnnotation(
  ann: Annotation,
  key: { key: string; shiftKey: boolean; altKey: boolean },
  page: { width: number; height: number }
): Annotation | null {
  const dir = STEP[key.key];
  if (!dir) return null;
  const step = key.shiftKey ? 10 : 1;
  const [ux, uy] = dir;
  const isLine = ann.type === "shape" && (ann.shape === "line" || ann.shape === "arrow");

  if (!key.altKey) {
    const x = keepIn(ann.x + ux * step, ann.x, 0, page.width - ann.width);
    const y = keepIn(ann.y + uy * step, ann.y, 0, page.height - ann.height);
    const dx = x - ann.x;
    const dy = y - ann.y;
    if (isLine && ann.type === "shape") {
      return {
        ...ann,
        x,
        y,
        x1: (ann.x1 ?? ann.x) + dx,
        y1: (ann.y1 ?? ann.y) + dy,
        x2: (ann.x2 ?? ann.x + ann.width) + dx,
        y2: (ann.y2 ?? ann.y + ann.height) + dy,
      };
    }
    return { ...ann, x, y };
  }

  if (isLine && ann.type === "shape") {
    const x1 = ann.x1 ?? ann.x;
    const y1 = ann.y1 ?? ann.y;
    const x2 = keepIn((ann.x2 ?? ann.x + ann.width) + ux * step, ann.x2 ?? ann.x + ann.width, 0, page.width);
    const y2 = keepIn((ann.y2 ?? ann.y + ann.height) + uy * step, ann.y2 ?? ann.y + ann.height, 0, page.height);
    return {
      ...ann,
      x2,
      y2,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  const width = Math.max(MIN, keepIn(ann.width + ux * step, ann.width, 0, page.width - ann.x));
  const height = Math.max(MIN, keepIn(ann.height + uy * step, ann.height, 0, page.height - ann.y));
  if (ann.type === "draw") {
    // Scale the stroke with its box, as the resize handles do.
    const sx = width / Math.max(1, ann.width);
    const sy = height / Math.max(1, ann.height);
    return { ...ann, width, height, points: ann.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) };
  }
  return { ...ann, width, height };
}

/** What a screen reader calls an annotation: its kind, a hint of its content and its page. */
export function annotationName(ann: Annotation): string {
  const snippet = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  };
  let detail = "";
  if (ann.type === "text" || ann.type === "note") detail = snippet(ann.text);
  else if (ann.type === "field") detail = ann.name;
  else if (ann.type === "link") detail = ann.targetPage !== null ? `to page ${ann.targetPage + 1}` : snippet(ann.url);
  return `${annotationLabel(ann)}${detail ? `: ${detail}` : ""}, page ${ann.page + 1}`;
}

export type PageAction = "rotate" | "insert" | "delete";

/**
 * Where focus goes after a page action in the page panel, once the panel
 * shows `pages` pages: Rotate again on the same page (to keep turning it),
 * the new page after an insert, the page that took a deleted one's place
 * (`action` unset means its thumbnail), or the same button when it failed.
 */
export function pageActionFocus(
  action: PageAction,
  index: number,
  ok: boolean,
  numPages: number
): { index: number; action?: PageAction; pages: number } {
  if (!ok || action === "rotate") return { index, action, pages: numPages };
  if (action === "insert") return { index: index + 1, pages: numPages + 1 };
  return { index: Math.min(index, numPages - 2), pages: numPages - 1 };
}
