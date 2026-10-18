/**
 * Images to PDF in a Web Worker: right-sizing a phone photo takes seconds of
 * decoding, resizing and encoding, which froze the page once per picture.
 * Where there are no workers (Node tests) or the worker can't start, it runs
 * on this thread instead. Either way it stops on `signal`.
 */
import { workerJob } from "../../worker-job";
import { imagesToPdf, type ImagesToPdfOptions } from "./index";
import type { Reply, Request } from "./worker";

export async function imagesToPdfFile(
  files: File[],
  opts: ImagesToPdfOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const here = () => imagesToPdf(files, opts, onProgress, signal);
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(
    worker,
    { files, opts: { pageSize: opts.pageSize, margin: opts.margin } } satisfies Request,
    [],
    onProgress,
    signal
  );
  if (!reply) return here();
  if (reply.type === "done") return reply.bytes;
  throw new Error(reply.message);
}
