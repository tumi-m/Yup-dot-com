/**
 * Flattening in a Web Worker, so reading and saving a long document never
 * freezes the page. Where there are no workers (Node tests), or the worker
 * can't start, it runs on this thread instead. Either way it stops on
 * `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { NothingToFlattenError, flattenPdf, type FlattenReport, type FlattenScope } from "./index";
import type { Reply, Request } from "./worker";

export async function flattenFile(
  file: Blob,
  scope: FlattenScope,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; report: FlattenReport }> {
  const here = async () => {
    stopIfAborted(signal);
    return flattenPdf(new Uint8Array(await file.arrayBuffer()), scope, { onProgress, signal });
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
    { bytes, scope } satisfies Request,
    [bytes.buffer],
    onProgress,
    signal
  );
  if (!reply) return here();
  if (reply.type === "done") return { bytes: reply.bytes, report: reply.report };
  if (reply.kind === "nothing") throw new NothingToFlattenError(reply.message);
  throw new Error(reply.message);
}
