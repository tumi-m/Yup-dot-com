// An X, TikTok or Instagram video was read into the tab three times over:
// the chunks as they came, one array copied from them, then a Blob of that.
// A 589 MB video took the tab to 1.9 GB, enough to crash a phone's. The bytes
// now join the Blob a few megabytes at a time.
import { HELD_BYTES, readToBlob } from "../lib/read-response.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

/** A response that sends `size` bytes in 64 KB chunks, or stops after `upTo`. */
function response(size: number, upTo = size): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      if (sent >= upTo) return ctl.close();
      const n = Math.min(65536, upTo - sent);
      ctl.enqueue(new Uint8Array(n).map((_, i) => (sent + i) % 251));
      sent += n;
    },
  });
  return new Response(body, { headers: { "content-length": String(size) } });
}

// Every Blob the reader makes, and how many raw bytes went into each.
const NativeBlob = Blob;
const raw: number[] = [];
globalThis.Blob = class extends NativeBlob {
  constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
    raw.push((parts ?? []).reduce((n, p) => n + (p instanceof NativeBlob ? 0 : typeof p === "string" ? p.length : (p as ArrayBufferView).byteLength), 0));
    super(parts, opts);
  }
} as typeof Blob;

const size = 40 * 1024 * 1024 + 12345;
const seen: number[] = [];
const blob = await readToBlob(response(size), "video/mp4", (f) => seen.push(f));
globalThis.Blob = NativeBlob;

check("the whole file arrives", blob.size === size, blob.size);
check("as the type asked for", blob.type === "video/mp4", blob.type);
const bytes = new Uint8Array(await blob.arrayBuffer());
check("byte for byte", bytes.every((b, i) => b === i % 251));
check("progress rises to 1", seen.at(-1) === 1 && seen.every((f, i) => !i || f >= seen[i - 1]), seen.at(-1));
check("never more than a few megabytes held outside the Blob", Math.max(...raw) <= HELD_BYTES + 65536, Math.max(...raw));
check("every byte went into the Blob once", raw.reduce((a, b) => a + b, 0) === size, raw.reduce((a, b) => a + b, 0));

const short = await readToBlob(response(1_000_000, 600_000), "video/mp4", () => {}).then(
  () => "",
  (err) => (err as Error).message
);
check("a stream that stops short fails", short === "incomplete", short);

const unknown = await readToBlob(new Response("hello"), "text/plain", () => {});
check("no size given: still read", (await unknown.text()) === "hello");

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
