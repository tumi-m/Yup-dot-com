// The MP3 tools sat at "40% Preparing converter…" for as long as the 31 MB
// converter took to download, which on a slow line the first time is
// minutes. The page now fetches it, says how much has come, and hands it to
// the converter's worker from memory.
import { statSync } from "node:fs";
import { FFMPEG_CORE_BYTES, coreDownloadLabel, loadMp3Converter } from "../lib/mp3.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const core = "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm";
check("the core's size is the installed file's", statSync(core).size === FFMPEG_CORE_BYTES, statSync(core).size);
check("label: so far, of the whole", coreDownloadLabel(12 * 1024 * 1024) === "Downloading the converter… 12 of 31 MB", coreDownloadLabel(12 * 1024 * 1024));

/** The ffmpeg worker: answers LOAD, and remembers what it was sent. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: { id: number; type: string; data: { wasmURL?: string } }[] = [];
  terminated = false;
  constructor(public url: string) {
    FakeWorker.all.push(this);
  }
  postMessage(msg: { id: number; type: string; data: { wasmURL?: string } }) {
    this.sent.push(msg);
    if (msg.type === "LOAD") setTimeout(() => this.onmessage?.({ data: { id: msg.id, type: "LOAD", data: true } }), 0);
  }
  terminate() {
    this.terminated = true;
  }
}

const g = globalThis as Record<string, unknown>;
g.window = { location: { origin: "https://pdfwizard.test" } };
g.Worker = FakeWorker;
const realFetch = globalThis.fetch;
const revoked: string[] = [];
const revoke = URL.revokeObjectURL;
URL.revokeObjectURL = (url: string) => {
  revoked.push(url);
  revoke(url);
};

/** Serves the core in 1 MB pieces, compressed in transit (so its length header is no help), or fails. */
let serve: "ok" | "fail" | "slow" = "ok";
const requested: string[] = [];
globalThis.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
  requested.push(String(url));
  if (serve === "fail") throw new TypeError("Failed to fetch");
  let sent = 0;
  const piece = 1024 * 1024;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (serve === "slow") await new Promise((r) => setTimeout(r, 5));
      if (init?.signal?.aborted) return ctl.error(new DOMException("Cancelled.", "AbortError"));
      if (sent >= FFMPEG_CORE_BYTES) return ctl.close();
      const n = Math.min(piece, FFMPEG_CORE_BYTES - sent);
      ctl.enqueue(new Uint8Array(n));
      sent += n;
    },
  });
  return new Response(body, { headers: { "content-encoding": "br", "content-length": "9000000", "content-type": "application/wasm" } });
}) as typeof fetch;

const seen: [number, number][] = [];
const converter = await loadMp3Converter(undefined, (fraction, received) => seen.push([fraction, received]));
const w = FakeWorker.all[0];
const load = w.sent.find((m) => m.type === "LOAD")!;
check("the core is fetched by the page", requested[0] === "https://pdfwizard.test/vendor/ffmpeg-core/0.12.10/ffmpeg-core.wasm", requested);
check("its download is followed as it comes", seen.length >= 30 && seen.every(([f], i) => !i || f >= seen[i - 1][0]), seen.length);
check("to the whole core, counted in real bytes", seen.at(-1)?.[0] === 1 && seen.at(-1)?.[1] === FFMPEG_CORE_BYTES, seen.at(-1));
check("the worker gets it from memory", load.data.wasmURL?.startsWith("blob:") === true, load.data.wasmURL);
check("and the memory is let go once loaded", revoked.includes(load.data.wasmURL!), revoked);
converter.dispose();

// Can't fetch it here (blocked, offline): the worker fetches it as before.
serve = "fail";
FakeWorker.all = [];
const fallback = await loadMp3Converter();
check("can't fetch here: the worker is given the core's own address", FakeWorker.all[0].sent.find((m) => m.type === "LOAD")?.data.wasmURL === "https://pdfwizard.test/vendor/ffmpeg-core/0.12.10/ffmpeg-core.wasm");
fallback.dispose();

// Cancel while it downloads.
serve = "slow";
FakeWorker.all = [];
const stop = new AbortController();
let got = 0;
const cancelled = await loadMp3Converter(stop.signal, (_f, received) => {
  got = received;
  if (received >= 3 * 1024 * 1024) stop.abort();
}).then(
  () => "loaded",
  (err) => (err as Error).name
);
check("cancel during the download stops it", cancelled === "AbortError" && got < FFMPEG_CORE_BYTES, { cancelled, got });
check("and ends the worker", FakeWorker.all[0].terminated && !FakeWorker.all[0].sent.some((m) => m.type === "LOAD"));

globalThis.fetch = realFetch;
URL.revokeObjectURL = revoke;
delete g.window;
delete g.Worker;

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
