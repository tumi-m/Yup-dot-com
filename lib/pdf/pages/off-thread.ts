/**
 * The page tools' save in a Web Worker: pdf-lib reads and writes the whole
 * file, which froze the page for seconds on long documents. Where there are
 * no workers (Node tests) or the worker can't start, it runs on this thread
 * instead. Either way it stops on `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { buildPages } from "./index";
import type { PagesMode, PlanItem } from "./plan";
import type { Reply, Request } from "./worker";

export async function buildPagesFile(
  files: File[],
  plan: PlanItem[],
  mode: PagesMode,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const here = async () => {
    stopIfAborted(signal);
    const sources = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
    return buildPages(sources, plan, { mode, names: files.map((f) => f.name), onProgress, signal });
  };
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  // Files go over as they are; the worker reads them, so this page never holds their bytes.
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(
    worker,
    { files, plan, mode } satisfies Request,
    [],
    onProgress,
    signal
  );
  if (!reply) return here();
  if (reply.type === "done") return reply.bytes;
  throw new Error(reply.message);
}
