// JPEG encoding in a worker (lib/jpeg-encode): one worker for the page, each
// reply matched to its request, the caller's pixels left readable, and the
// same bytes encoded on this thread when the worker can't help.
import { readFileSync } from "node:fs";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Loaded dynamically: tsx gives a static import its own copy of the module,
// and the wasm has to reach the copy the app modules use.
const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({ encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")) });

// A stand-in for the browser: the worker script runs here, behind messages
// that are copied as postMessage copies them.
let created = 0;
let crash = false;
let current: { onmessage: ((e: { data: unknown }) => void) | null } | null = null;
const g = globalThis as unknown as Record<string, unknown>;
g.postMessage = (reply: unknown) => setTimeout(() => current?.onmessage?.({ data: structuredClone(reply) }));
await import("../lib/jpeg-encode/worker.ts");
const handler = g.onmessage as (e: { data: unknown }) => void;
const { canvasToJpeg } = await import("../lib/jpeg-encode/off-thread.ts");
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { preventDefault(): void }) => void) | null = null;
  constructor(url: URL) {
    created++;
    if (!String(url).endsWith("/jpeg-encode/worker.ts")) throw new Error("unexpected worker " + url);
    current = this;
  }
  postMessage(message: unknown) {
    const copy = structuredClone(message);
    setTimeout(() => (crash ? this.onerror?.({ preventDefault() {} }) : handler({ data: copy })));
  }
  terminate() {}
}
g.window = globalThis;
g.Worker = FakeWorker;

const image = (w: number, h: number, seed: number) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([(i * seed) & 255, (i >> 3) & 255, (seed * 40) & 255, 255], i);
  return { data, width: w, height: h };
};
const canvas = {} as HTMLCanvasElement; // not read: the pixels are passed in
const inline = (px: ReturnType<typeof image>, q: number) =>
  codec.encodeJpeg(px, { quality: codec.mozQuality(q), gray: false, fullChroma: q >= 1 });
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const a = image(120, 80, 3);
const b = image(64, 200, 7);
const [ja, jb] = await Promise.all([canvasToJpeg(canvas, 0.8, { pixels: a }), canvasToJpeg(canvas, 0.6, { pixels: b })]);
check("each reply goes to its own request", same(ja, await inline(a, 0.8)) && same(jb, await inline(b, 0.6)));
check("one worker serves every page", created === 1, created);
check("the pixels stay readable for the caller", a.data.byteLength === 120 * 80 * 4 && b.data.byteLength === 64 * 200 * 4);
await canvasToJpeg(canvas, 0.8, { pixels: a });
check("and it is kept between jobs", created === 1, created);

crash = true;
const jc = await canvasToJpeg(canvas, 0.8, { pixels: a });
check("a crashed worker: encoded on this thread instead", same(jc, ja));
const jd = await canvasToJpeg(canvas, 0.6, { pixels: b });
check("and no new worker is started for later pages", same(jd, jb) && created === 1, created);

// The worker loads image-codec.ts: if that started the worker in turn, the
// bundler would build the worker into itself and the build would never end.
const startsWorker = /jpeg-encode\/off-thread|new Worker/;
check("the worker's own code never starts it", !startsWorker.test(readFileSync("lib/image-codec.ts", "utf8")) && !startsWorker.test(readFileSync("lib/jpeg-encode/worker.ts", "utf8")));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
