// Edit PDF drew a thumbnail of every page as soon as a document opened, and
// all of them again after any page action: a 2000-page document froze the
// tab for half a minute and took 2.7 GB. Thumbnails are now drawn only near
// the visible part of the list, a few at a time (components/editor/ThumbnailSidebar.tsx).
import { readFileSync } from "node:fs";
import { DRAWN_AT_ONCE, taskLimiter } from "../lib/editor/thumbnails.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- A few at a time -------------------------------------------------------------
{
  const run = taskLimiter(2);
  let running = 0;
  let most = 0;
  const order: number[] = [];
  const tasks = Array.from({ length: 12 }, (_, i) =>
    run(async () => {
      running++;
      most = Math.max(most, running);
      order.push(i);
      await wait(2 + (i % 3));
      running--;
      if (i === 5) throw new Error("this page can't be drawn");
      return i;
    }).catch(() => -1)
  );
  const results = await Promise.all(tasks);
  check("never more than two at once", most === 2, most);
  check("in the order they came", order.join() === Array.from({ length: 12 }, (_, i) => i).join(), order);
  check("a failure doesn't hold up the rest", results.filter((r) => r >= 0).length === 11 && results[5] === -1, results);
}

{
  // A new task arriving just as one finishes must not make a third at once.
  const run = taskLimiter(2);
  let running = 0;
  let most = 0;
  const job = (ms: number) =>
    run(async () => {
      running++;
      most = Math.max(most, running);
      await wait(ms);
      running--;
    });
  const first = [job(5), job(5), job(5)];
  await first[0];
  const late = [job(5), job(5)];
  await Promise.all([...first, ...late]);
  check("a finished task hands its place on, none slips in", most === 2, most);
}

{
  // Scrolled past before their turn: they return at once and the rest go on.
  const run = taskLimiter(1);
  const gone = new Set([1, 2, 3]);
  const drawn: number[] = [];
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      run(async () => {
        if (gone.has(i)) return;
        await wait(3);
        drawn.push(i);
      })
    )
  );
  check("pages scrolled past are skipped", drawn.join() === "0,4", drawn);
}

check("a few pages drawn at once", DRAWN_AT_ONCE >= 1 && DRAWN_AT_ONCE <= 3, DRAWN_AT_ONCE);

// The list itself: drawn on coming near, released far away, and not all at once.
const sidebar = readFileSync("components/editor/ThumbnailSidebar.tsx", "utf8");
check("thumbnails wait to come near the visible list", /IntersectionObserver/.test(sidebar) && /if \(!near \|\| !canvas\) return;/.test(sidebar));
check("and take their turn to be drawn", /slot\(async \(\) => \{/.test(sidebar));
check("far away they let go of their pixels", /if \(!near && ref\.current\) release\(ref\.current\);/.test(sidebar));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
