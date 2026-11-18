/**
 * The pdf-lib parts of a repair in a Web Worker: reading and checking a
 * damaged file, and putting the pictures in place. Where there are no
 * workers (Node tests), or the worker can't start, they run on this thread
 * instead. Either way they stop on `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { NothingRecoveredError, rebuildPdf, splicePictures, type Extras, type Rebuilt } from "./rebuild";
import type { Reply, Request } from "./worker";

type Progress = (fraction: number, label: string) => void;

/** A worker answered the first step, so the second goes there too. */
let workerAnswered = false;

async function inWorker(request: Request, transfer: ArrayBuffer[], onProgress?: Progress, signal?: AbortSignal) {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, request, transfer, onProgress, signal);
  if (reply) workerAnswered = true;
  if (reply?.type === "error") throw reply.kind === "nothing" ? new NothingRecoveredError(reply.message) : new Error(reply.message);
  return reply;
}

export async function rebuildFile(file: Blob, onProgress?: Progress, signal?: AbortSignal): Promise<Rebuilt> {
  // Handed over, not copied: the page keeps the file, not a second buffer.
  const bytes = new Uint8Array(await file.arrayBuffer());
  stopIfAborted(signal);
  const reply = await inWorker({ op: "rebuild", bytes }, [bytes.buffer], onProgress, signal);
  if (reply?.type === "rebuilt") return reply.result;
  stopIfAborted(signal);
  return rebuildPdf(new Uint8Array(await file.arrayBuffer()), { onProgress, signal });
}

export async function spliceFile(
  vector: Uint8Array,
  pictures: Uint8Array | null,
  placed: number[],
  empty: number[],
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; after: Extras; pages: number }> {
  stopIfAborted(signal);
  if (!workerAnswered) return splicePictures(vector, pictures, placed, empty);
  // Handed over, not copied: a long file must not be held twice.
  const transfer = [vector.buffer as ArrayBuffer, ...(pictures ? [pictures.buffer as ArrayBuffer] : [])];
  const reply = await inWorker({ op: "splice", vector, pictures, placed, empty }, [...new Set(transfer)], undefined, signal);
  if (reply?.type === "spliced") return reply;
  // The worker stopped (out of memory, most likely) with the pages it was given.
  throw new Error("The repair stopped part way, perhaps for lack of memory. Close other tabs and try again.");
}
