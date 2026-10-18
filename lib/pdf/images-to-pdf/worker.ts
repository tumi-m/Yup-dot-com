/**
 * Runs imagesToPdf in a Web Worker so the page stays responsive while photos
 * are decoded, resized and encoded (see off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { imagesToPdf, type ImagesToPdfOptions } from "./index";

export type Request = { files: File[]; opts: ImagesToPdfOptions };
export type Reply = ProgressReply | { type: "done"; bytes: Uint8Array } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const bytes = await imagesToPdf(data.files, data.opts, (fraction, label) => scope.postMessage({ type: "progress", fraction, label }));
    scope.postMessage({ type: "done", bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
