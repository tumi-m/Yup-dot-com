// On a phone the page in the PDF editor must scroll under a finger with the
// Select tool (it used to take every touch, so the bottom of a zoomed page
// couldn't be reached), and a box placed under the properties sheet must be
// brought into view.
import { annotationTouchAction, pageTouchAction, revealOffset } from "../lib/editor/canvas.ts";
import type { ToolId } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

check("Select: a swipe scrolls the page", pageTouchAction("select") === "pan-x pan-y");
for (const tool of ["text", "draw", "rect", "highlight", "signature", "image", "note"] as ToolId[]) {
  check(`${tool}: the tool takes the touch`, pageTouchAction(tool) === "none");
}
check("a selected annotation is dragged", annotationTouchAction(true, true) === "none");
check("a swipe that starts on another annotation scrolls", annotationTouchAction(true, false) === undefined);
check("while drawing, the page layer decides", annotationTouchAction(false, false) === undefined);

// At 390x844 the sheet covered y 534-844 and the new box sat at y 591-605.
const view = { top: 112, bottom: 534 };
const hidden = revealOffset({ top: 591, bottom: 605 }, view);
check("a box under the sheet scrolls up above it", hidden === 605 - (534 - 16), hidden);
check("then it's in view", revealOffset({ top: 591 - hidden, bottom: 605 - hidden }, view) === 0);
check("a box in view stays put", revealOffset({ top: 300, bottom: 320 }, view) === 0);
check("a box above the view scrolls down to it", revealOffset({ top: 80, bottom: 100 }, view) === 80 - (112 + 16));
const tall = revealOffset({ top: 400, bottom: 900 }, view);
check("a box taller than the view shows its top", tall === 400 - (112 + 16), tall);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
