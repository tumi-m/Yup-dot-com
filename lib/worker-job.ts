import { abortError } from "./abort";

/** What a job's worker sends while it works. */
export type ProgressReply = { type: "progress"; fraction: number; label: string };

/**
 * Hands one job to `worker` and waits for its answer, passing progress on.
 * The answer is the first reply that isn't progress, or null when the worker
 * script didn't load or crashed. The worker is stopped once it answers, and
 * at once on abort, which rejects with an AbortError: nothing keeps working
 * for a page the person has left.
 */
export function workerJob<Reply extends { type: string }>(
  worker: Worker,
  request: unknown,
  transfer: Transferable[],
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Reply | null> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      stop();
      reject(abortError());
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<Reply | ProgressReply>) => {
      if (data.type === "progress") {
        const { fraction, label } = data as ProgressReply;
        return onProgress?.(fraction, label);
      }
      stop();
      resolve(data as Reply);
    };
    // The worker script didn't load or crashed.
    worker.onerror = (e) => {
      e.preventDefault();
      stop();
      resolve(null);
    };
    worker.postMessage(request, transfer);
  });
}
