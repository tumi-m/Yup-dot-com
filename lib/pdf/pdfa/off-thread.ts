/**
 * The pdf-lib steps of PDF to PDF/A in a Web Worker. Where there are no
 * workers (Node tests), or the worker can't start, they run on this thread
 * instead, with fonts from `fonts`. Either way they stop on `signal`.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { PasswordError, finishPdfa, preparePdfa, type PdfaFacts, type PdfaResult, type Prepared } from "./convert";
import type { FontFiles } from "./fonts";
import type { Part } from "./metadata";
import type { Reply, Request } from "./worker";

type Progress = (fraction: number, label: string) => void;

/** A worker answered the first step, so the second goes there too. */
let workerAnswered = false;

async function inWorker(request: Request, transfer: ArrayBuffer[], onProgress?: Progress, signal?: AbortSignal) {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(worker, request, transfer, onProgress, signal);
  if (reply) workerAnswered = true;
  if (reply?.type === "error") throw reply.kind === "password" ? new PasswordError(reply.message) : new Error(reply.message);
  return reply;
}

export async function prepareFile(
  file: Blob,
  opts: { part: Part; password?: string; fonts?: FontFiles },
  onProgress?: Progress,
  signal?: AbortSignal
): Promise<Prepared> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  stopIfAborted(signal);
  if (!opts.fonts) {
    // Handed over, not copied: the page keeps the file, not a second buffer.
    workerAnswered = false;
    const reply = await inWorker({ op: "prepare", bytes, part: opts.part, password: opts.password }, [bytes.buffer], onProgress, signal);
    if (reply?.type === "prepared") return reply.prepared;
  }
  stopIfAborted(signal);
  const { vendorFonts } = await import("./fonts");
  return preparePdfa(new Uint8Array(await file.arrayBuffer()), { ...opts, fonts: opts.fonts ?? vendorFonts, onProgress, signal });
}

export async function finishFile(vector: Uint8Array, pictures: Uint8Array, facts: PdfaFacts, onProgress?: Progress, signal?: AbortSignal): Promise<PdfaResult> {
  stopIfAborted(signal);
  if (workerAnswered) {
    const reply = await inWorker({ op: "finish", vector, pictures, facts }, [vector.buffer as ArrayBuffer, pictures.buffer as ArrayBuffer], onProgress, signal);
    if (reply?.type === "finished") return reply.result;
    throw new Error("The conversion stopped part way, perhaps for lack of memory. Close other tabs and try again.");
  }
  return finishPdfa(vector, pictures, facts, { part: facts.part, onProgress, signal });
}
