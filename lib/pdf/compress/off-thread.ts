/**
 * Compression in a Web Worker, so a long image pass never freezes the page.
 * Where there are no workers (Node tests), or the worker can't start or can't
 * load the image codec there, it runs on this thread instead.
 */
import { UnreadablePdfError, compressPdf, type Preset } from "./index";
import type { Reply, Request } from "./worker";

export async function compressFile(
  file: Blob,
  preset: Preset,
  onProgress?: (fraction: number, label: string) => void
): Promise<Uint8Array> {
  const here = async () => compressPdf(new Uint8Array(await file.arrayBuffer()), { preset, onProgress });
  if (typeof window === "undefined" || typeof Worker === "undefined") return here();
  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return here();
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reply = await new Promise<Reply | null>((resolve) => {
    worker.onmessage = ({ data }: MessageEvent<Reply>) => {
      if (data.type === "progress") onProgress?.(data.fraction, data.label);
      else resolve(data);
    };
    // The worker script didn't load or crashed.
    worker.onerror = (e) => {
      e.preventDefault();
      resolve(null);
    };
    worker.postMessage({ bytes, preset } satisfies Request, [bytes.buffer]);
  });
  worker.terminate();
  if (!reply || (reply.type === "error" && reply.kind === "codec")) return here();
  if (reply.type === "done") return reply.bytes;
  if (reply.type === "error" && reply.kind === "unreadable") throw new UnreadablePdfError(reply.message);
  throw new Error(reply.type === "error" ? reply.message : "Something went wrong.");
}
