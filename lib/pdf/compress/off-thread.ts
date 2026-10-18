/**
 * Compression in a Web Worker, so a long image pass never freezes the page.
 * Where there are no workers (Node tests), or the worker can't start or can't
 * load the image codec there, it runs on this thread instead. Either way it
 * stops on `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { UnreadablePdfError, compressPdf, type Preset } from "./index";
import type { Reply, Request } from "./worker";

export async function compressFile(
  file: Blob,
  preset: Preset,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const here = async () => {
    stopIfAborted(signal);
    return compressPdf(new Uint8Array(await file.arrayBuffer()), { preset, onProgress, signal });
  };
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(
    worker,
    { bytes, preset } satisfies Request,
    [bytes.buffer],
    onProgress,
    signal
  );
  if (!reply || (reply.type === "error" && reply.kind === "codec")) return here();
  if (reply.type === "done") return reply.bytes;
  if (reply.kind === "unreadable") throw new UnreadablePdfError(reply.message);
  throw new Error(reply.message);
}
