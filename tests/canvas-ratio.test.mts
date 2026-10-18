// The iOS Safari canvas limit (see canvas-limit.test.mts, for an iPhone)
// takes sharpness only where a page needs it: a zoomed page on a laptop keeps
// its pixel ratio, or nearly, and a poster-size page stays within the limits
// even on a 1× screen.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
const { canvasRatio } = await import("../lib/pdf/render.ts");

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const IOS_LIMIT = 4096 * 4096;
const A4 = { width: 595.28, height: 841.89 };
/** The canvas renderPage makes for a page (A4 by default) at `zoom`, on a `screen`× screen. */
function canvas(zoom: number, screen: number, page = A4) {
  const width = page.width * zoom;
  const height = page.height * zoom;
  const ratio = canvasRatio(width, height, screen);
  return { w: Math.floor(width * ratio), h: Math.floor(height * ratio), ratio };
}

check("laptop (2× screen), 200%: full sharpness", canvas(2, 2).ratio === 2, canvas(2, 2));
check("laptop (2× screen), 300%: nearly full sharpness", canvas(3, 2).ratio > 1.9, canvas(3, 2));
const poster = canvas(2, 1, { width: 2384, height: 3370 });
check("a poster-size page stays within the limit too", poster.w * poster.h <= IOS_LIMIT && poster.w <= 8192 && poster.h <= 8192, poster);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
