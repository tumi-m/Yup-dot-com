/**
 * Translate PDF's files in a Web Worker: a long document takes seconds to
 * lay out, which would freeze the page. Where there are no workers (Node
 * tests) or the worker can't start, it runs on this thread instead. Either
 * way it stops on `signal`.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { vendorFonts, type FontFiles } from "../text-to-pdf/fonts";
import { buildOutputs, type OutputRequest, type Outputs } from "./output";
import type { Reply } from "./worker";

export async function writeTranslation(
  req: OutputRequest,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal,
  fonts: FontFiles = vendorFonts
): Promise<Outputs> {
  const here = () => {
    stopIfAborted(signal);
    return buildOutputs(req, fonts, onProgress, signal);
  };
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, req, [], onProgress, signal);
  if (!reply) return here();
  if (reply.type === "done") return { docx: reply.docx, pdf: reply.pdf, note: reply.note };
  throw new Error(reply.message);
}
