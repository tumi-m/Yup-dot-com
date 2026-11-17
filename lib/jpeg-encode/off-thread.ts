/**
 * JPEG encoding off the main thread. PDF to JPG and PDF to PowerPoint encode
 * a picture per page, and MozJPEG on this thread blocked clicks and scrolling
 * for most of the job. One worker is started on first use and kept for the
 * page's lifetime. Resolves null where it can't run (no workers, as in Node
 * tests or inside another worker, or the worker failed to start or crashed):
 * the caller then encodes here.
 */
import type { JpegOptions, RawImage } from "../image-codec";
import type { Reply, Request } from "./worker";

let worker: Worker | null = null;
/** Set once the worker failed: from then on everything is encoded on this thread. */
let broken = false;
let nextId = 0;
const waiting = new Map<number, (bytes: Uint8Array | null) => void>();

function start(): Worker | null {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    broken = true;
    return null;
  }
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    const done = waiting.get(data.id);
    waiting.delete(data.id);
    done?.("bytes" in data ? data.bytes : null);
  };
  // The script didn't load or the worker crashed: what it held is encoded here.
  worker.onerror = (e) => {
    e.preventDefault();
    broken = true;
    worker?.terminate();
    worker = null;
    for (const done of waiting.values()) done(null);
    waiting.clear();
  };
  return worker;
}

export function encodeJpegOffThread(pixels: RawImage, opts: JpegOptions): Promise<Uint8Array | null> {
  if (typeof window === "undefined" || typeof Worker === "undefined") return Promise.resolve(null);
  const w = start();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    // Copied, not transferred: the caller may read the same pixels again.
    try {
      w.postMessage({ id, pixels, opts } satisfies Request);
    } catch {
      waiting.delete(id);
      resolve(null);
    }
  });
}
