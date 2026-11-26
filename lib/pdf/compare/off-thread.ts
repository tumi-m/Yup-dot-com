/**
 * Compare PDFs' worker steps (see worker.ts). Where there are no workers
 * (Node tests) or the worker can't start, they run on this thread instead.
 * Either way they stop on `signal`: the worker is ended at once.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { vendorFonts, type FontFiles } from "../text-to-pdf/fonts";
import { writeExports, type ExportJob, type Exports } from "./exports";
import { compareWords, type CompareResult } from "./index";
import type { ReadDocument } from "./words";
import type { Reply, Request } from "./worker";

type Progress = (fraction: number, label: string) => void;

async function inWorker(request: Request, transfer: Transferable[], onProgress?: Progress, signal?: AbortSignal) {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, request, transfer, onProgress, signal);
  if (reply?.type === "error") throw new Error(reply.message);
  return reply;
}

export async function diffOffThread(a: ReadDocument, b: ReadDocument, signal?: AbortSignal): Promise<CompareResult> {
  stopIfAborted(signal);
  const reply = await inWorker({ op: "diff", a, b }, [], undefined, signal);
  if (reply?.type === "diffed") return reply.result;
  stopIfAborted(signal);
  return compareWords(a, b);
}

/** The files to export from, as Blobs: each is read when it is needed. */
export type ExportFiles = Omit<ExportJob, "a" | "b"> & {
  a: Omit<ExportJob["a"], "bytes"> & { file: Blob };
  b: Omit<ExportJob["b"], "bytes"> & { file: Blob };
};

export async function exportsOffThread(files: ExportFiles, onProgress?: Progress, signal?: AbortSignal, fonts: FontFiles = vendorFonts): Promise<Exports> {
  const read = async (): Promise<ExportJob> => {
    const [a, b] = await Promise.all([files.a.file.arrayBuffer(), files.b.file.arrayBuffer()]);
    stopIfAborted(signal);
    const side = ({ file: _file, ...rest }: ExportFiles["a"], bytes: ArrayBuffer) => ({ ...rest, bytes: new Uint8Array(bytes) });
    return { ...files, a: side(files.a, a), b: side(files.b, b) };
  };
  stopIfAborted(signal);
  const job = await read();
  // Handed over, not copied: the page keeps the files, not second buffers.
  const transfer = [...new Set([job.a.bytes.buffer as ArrayBuffer, job.b.bytes.buffer as ArrayBuffer])];
  const reply = await inWorker({ op: "export", ...job }, transfer, onProgress, signal);
  if (reply?.type === "exported") return reply.exports;
  stopIfAborted(signal);
  // The worker didn't start or stopped: the files are read again if they went to it.
  return writeExports(job.a.bytes.byteLength && job.b.bytes.byteLength ? job : await read(), fonts, onProgress);
}
