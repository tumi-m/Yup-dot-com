// What a creation drag leaves on the page. A level or upright line or arrow
// has no height or width, and a highlight dragged along a line of text is
// nearly flat: all of them used to be thrown away as stray clicks.
import { createAnnotation, finishDraft, resizeDraft } from "../lib/editor/factory.ts";
import { DEFAULT_SETTINGS, type Annotation, type ToolId } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const drag = (tool: ToolId, x1: number, y1: number, x2: number, y2: number): Annotation | null => {
  const start = createAnnotation(tool, DEFAULT_SETTINGS, x1, y1)!;
  return finishDraft(resizeDraft(start, x1, y1, x2, y2));
};

const level = drag("line", 60, 150, 300, 150);
check("a level line is kept", level?.type === "shape" && level.width === 240 && level.height === 0, level);
const upright = drag("arrow", 80, 100, 80, 260);
check("an upright arrow is kept", upright?.type === "shape" && upright.height === 160 && upright.width === 0, upright);
check("a click with the line tool makes nothing", drag("line", 60, 150, 62, 151) === null);

const under = drag("underline", 60, 200, 260, 201);
check("an underline dragged along a line is kept", !!under && under.width === 200 && under.height === 14, under);
check("and its line lands where the drag went", !!under && Math.abs(under.y + under.height - 200.5) < 0.01, under);
const high = drag("highlight", 60, 300, 260, 300);
check("a flat highlight is centred on the drag", !!high && high.height === 14 && Math.abs(high.y + 7 - 300) < 0.01, high);
const strike = drag("strikeout", 260, 400, 60, 402);
check("a strikeout dragged right to left too", !!strike && strike.x === 60 && Math.abs(strike.y + 7 - 401) < 0.01, strike);
check("a tall highlight keeps its box", JSON.stringify(drag("highlight", 60, 300, 260, 340)) !== "null" && drag("highlight", 60, 300, 260, 340)!.height === 40);
check("a mark near the top stays on the page", (drag("underline", 60, 5, 200, 5)?.y ?? -1) === 0);
check("a mark too short to see makes nothing", drag("highlight", 60, 300, 62, 300) === null);

check("a rectangle still needs some size both ways", drag("rect", 60, 60, 200, 62) === null && drag("rect", 60, 60, 200, 100) !== null);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
