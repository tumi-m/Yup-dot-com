/**
 * How the editor's page behaves under a finger and under the phone sheet.
 * Kept free of React so it can be unit tested.
 */
import type { ToolId } from "./types";

/**
 * touch-action for the page layer. With the Select tool a swipe scrolls the
 * page; drawing and placing tools take every touch for themselves.
 */
export function pageTouchAction(tool: ToolId): "pan-x pan-y" | "none" {
  return tool === "select" ? "pan-x pan-y" : "none";
}

/**
 * touch-action for one annotation. A selected one is dragged and resized
 * with a finger; any other lets a swipe that starts on it scroll the page.
 */
export function annotationTouchAction(interactive: boolean, selected: boolean): "none" | undefined {
  return interactive && selected ? "none" : undefined;
}

interface Span {
  top: number;
  bottom: number;
}

/**
 * How far to scroll so `box` sits inside `view` with `margin` to spare, or 0
 * when it already does. A box taller than the view shows its top.
 */
export function revealOffset(box: Span, view: Span, margin = 16): number {
  const above = box.top - (view.top + margin);
  if (above < 0) return above;
  const below = box.bottom - (view.bottom - margin);
  if (below > 0) return Math.min(below, above);
  return 0;
}
