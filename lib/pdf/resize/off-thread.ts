/**
 * Resize PDF in a Web Worker: a long document takes seconds to rewrite,
 * which would freeze the page. Where there are no workers (Node tests) or
 * the worker can't start, it runs on this thread instead. Either way it
 * stops on `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { resizePdf, type ResizeOptions } from "./index";
import type { Reply, Request } from "./worker";

export async function resizeFile(
  file: Blob,
  opts: ResizeOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const here = async () => {
    stopIfAborted(signal);
    return resizePdf(new Uint8Array(await file.arrayBuffer()), opts, onProgress, signal);
  };
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  // Handed over, not copied: the page keeps the file, not a second buffer.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(
    worker,
    { bytes, opts } satisfies Request,
    [bytes.buffer],
    onProgress,
    signal
  );
  if (!reply) return here();
  if (reply.type === "done") return reply.bytes;
  throw new Error(reply.message);
}
