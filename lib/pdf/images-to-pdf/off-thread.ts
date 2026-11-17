/**
 * Images to PDF in a Web Worker: right-sizing a phone photo takes seconds of
 * decoding, resizing and encoding, which froze the page once per picture.
 * Where there are no workers (Node tests) or the worker can't start, it runs
 * on this thread instead. Either way it stops on `signal`.
 *
 * SVGs need an <img> to be drawn and HEIC photos decode only where Safari
 * does it for the page, so those become pixels here first and go to the
 * worker ready to place.
 */
import { stopIfAborted } from "../../abort";
import { workerJob } from "../../worker-job";
import { decodeBitmap, decodeSvg } from "./decode";
import { sniffFormat } from "./formats";
import { imagesToPdf, wantFor, type ImageInput, type ImagesToPdfOptions } from "./index";
import type { Reply, Request } from "./worker";

/** Decodes on this thread what a worker can't decode. */
async function prepare(files: File[], opts: ImagesToPdfOptions, signal?: AbortSignal): Promise<ImageInput[]> {
  // Without OffscreenCanvas (Safari before 16.4) a worker can't decode any picture.
  const workerDecodes = typeof OffscreenCanvas !== "undefined";
  const out: ImageInput[] = [];
  for (const file of files) {
    stopIfAborted(signal);
    const format = sniffFormat(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
    const here = format === "svg" || format === "heic" || (!workerDecodes && (format === "webp" || format === "gif" || format === "bmp" || format === "avif"));
    if (!here) {
      out.push(file);
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const frame = format === "svg" ? await decodeSvg(bytes, file.name) : await decodeBitmap(bytes, format!, file.name, wantFor(opts));
    out.push({ name: file.name, frames: [frame], lossy: format === "heic" || format === "webp" || format === "avif" });
  }
  return out;
}

export async function imagesToPdfFile(
  files: File[],
  opts: ImagesToPdfOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (typeof window === "undefined" || typeof Worker === "undefined") return imagesToPdf(files, opts, onProgress, signal);
  const inputs = await prepare(files, opts, signal);
  const here = () => imagesToPdf(inputs, opts, onProgress, signal);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  // Pixels decoded here are copied to the worker, not handed over: if the
  // worker fails to start, this thread still needs them.
  const reply = await workerJob<Exclude<Reply, { type: "progress" }>>(
    worker,
    { files: inputs, opts: { pageSize: opts.pageSize, margin: opts.margin } } satisfies Request,
    [],
    onProgress,
    signal
  );
  if (!reply) return here();
  if (reply.type === "done") return reply.bytes;
  throw new Error(reply.message);
}
