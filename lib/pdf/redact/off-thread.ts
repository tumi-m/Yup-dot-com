/**
 * Redact PDF's writing in a Web Worker: pdf-lib reads, rebuilds, writes and
 * searches the whole file, which would freeze the page on a long document.
 * Where there are no workers (Node tests) or the worker can't start, it runs
 * on this thread instead. Either way it stops on `signal`: the worker is
 * ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { redactPdf, widenBoxes, type RedactJob, type RedactReport } from "./index";
import type { Reply, Request } from "./worker";

export async function redactFile(
  file: Blob,
  job: RedactJob,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; report: RedactReport }> {
  const here = async () => {
    stopIfAborted(signal);
    return redactPdf(new Uint8Array(await file.arrayBuffer()), job, onProgress, signal);
  };
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  // Copied, not handed over: if the worker can't start, the job still runs here with its pictures.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, { bytes, job } satisfies Request, [bytes.buffer], onProgress, signal);
  if (!reply) return here();
  if (reply.type === "done") return { bytes: reply.bytes, report: reply.report };
  if (reply.type === "error") throw new Error(reply.message);
  throw new Error("The file couldn't be redacted.");
}

/** The file with its pages' boxes made very large, to read text a crop hides (index.ts widenBoxes), written in the worker. */
export async function widenFile(file: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  const here = async () => {
    stopIfAborted(signal);
    return widenBoxes(new Uint8Array(await file.arrayBuffer()));
  };
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, { bytes, widen: true } satisfies Request, [bytes.buffer], undefined, signal);
  if (!reply) return here();
  if (reply.type === "wide") return reply.bytes;
  throw new Error(reply.type === "error" ? reply.message : "The file couldn't be read.");
}
