/**
 * Rendered pages to JPEG, off the main thread. PDF to JPG and PDF to
 * PowerPoint encode a picture per page, and MozJPEG on this thread blocked
 * clicks and scrolling for most of the job. One worker is started on first
 * use and kept for the page's lifetime. Where it can't run (no workers, as in
 * Node tests or inside another worker, or the worker failed to start or
 * crashed) the picture is encoded on this thread.
 *
 * This lives apart from image-codec.ts, which the worker loads: a module that
 * starts the worker and is also inside it would make the bundler build the
 * worker into itself without end.
 */
import { canvasPixels, encodeJpeg, isGray, mozQuality, type JpegOptions, type RawImage } from "../image-codec";
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

/** The JPEG from the worker, or null when it can't make one. */
function encodeOffThread(pixels: RawImage, opts: JpegOptions): Promise<Uint8Array | null> {
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

/**
 * Canvas pixels → JPEG with MozJPEG, falling back to the browser's encoder if
 * the wasm can't load. Pass `pixels` when they have been read already.
 * Grey renders get a one-channel JPEG; at quality 1 colour is kept at full
 * resolution, as the browser does. In a page the encoding runs in a worker,
 * so the page keeps answering clicks while each picture is made.
 */
export async function canvasToJpeg(
  canvas: HTMLCanvasElement,
  browserQuality: number,
  opts: { progressive?: boolean; pixels?: RawImage | null } = {}
): Promise<Uint8Array> {
  try {
    const pixels = opts.pixels ?? canvasPixels(canvas);
    if (pixels) {
      const jpeg: JpegOptions = {
        quality: mozQuality(browserQuality),
        progressive: opts.progressive,
        gray: isGray(pixels),
        fullChroma: browserQuality >= 1,
      };
      return (await encodeOffThread(pixels, jpeg)) ?? (await encodeJpeg(pixels, jpeg));
    }
  } catch {
    // Fall back below.
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", browserQuality));
  if (!blob) throw new Error("This page is too large to render on this device.");
  return new Uint8Array(await blob.arrayBuffer());
}
