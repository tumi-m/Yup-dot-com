/**
 * Crop PDF's writing in a Web Worker: pdf-lib reads and writes the whole
 * file, which would freeze the page on a long document. Where there are no
 * workers (Node tests) or the worker can't start, it runs on this thread
 * instead. Either way it stops on `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { cropPdf, type CropJob, type CropReport } from "./index";
import type { Reply, Request } from "./worker";

export async function cropFile(
  file: Blob,
  job: CropJob,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; report: CropReport }> {
  const here = async () => {
    stopIfAborted(signal);
    return cropPdf(new Uint8Array(await file.arrayBuffer()), job, onProgress, signal);
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
  throw new Error(reply.message);
}
