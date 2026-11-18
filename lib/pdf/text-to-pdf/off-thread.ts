/**
 * Text and Markdown to PDF in a Web Worker: a long file takes seconds to lay
 * out, which would freeze the page. Where there are no workers (Node tests)
 * or the worker can't start, it runs on this thread instead, pausing now and
 * then so the page still answers. Either way it stops on `signal`.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { vendorFonts, type FontFiles } from "./fonts";
import { textToPdf, type TextPdf, type TextToPdfOptions } from "./index";
import type { Reply, Request } from "./worker";

export async function textFileToPdf(
  file: File,
  markdown: boolean,
  opts: Partial<TextToPdfOptions>,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal,
  fonts: FontFiles = vendorFonts
): Promise<TextPdf> {
  const here = async () => {
    stopIfAborted(signal);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const convert = markdown ? (await import("./markdown")).markdownToPdf : textToPdf;
    return convert(bytes, file.name, opts, fonts, onProgress, signal);
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
    { bytes, name: file.name, markdown, opts } satisfies Request,
    [bytes.buffer],
    onProgress,
    signal
  );
  if (!reply) return here();
  if (reply.type === "done") return { bytes: reply.bytes, note: reply.note };
  throw new Error(reply.message);
}
