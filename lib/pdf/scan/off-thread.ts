/**
 * Scan to PDF's pages built in a Web Worker, so the page stays responsive;
 * where there are no workers (Node tests) or one can't start, on this
 * thread instead. Either way it stops on `signal`. The photos go to the
 * worker as Blobs, which are passed by reference, not copied.
 */
import { workerJob } from "../../worker-job";
import { buildScanPdf, type ScanOptions, type ScanPage } from "./build";
import type { Reply, Request } from "./worker";

export async function scanPagesToPdf(
  pages: ScanPage[],
  opts: ScanOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const here = () => buildScanPdf(pages, opts, onProgress, signal);
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, { pages, opts } satisfies Request, [], onProgress, signal);
  if (!reply) return here();
  if (reply.type === "done") return reply.bytes;
  throw new Error(reply.message);
}
