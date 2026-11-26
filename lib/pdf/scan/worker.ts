/**
 * Builds the scanned PDF in a Web Worker: flattening, filtering and encoding
 * each photo takes a second or so, which would freeze the page (off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { buildScanPdf, type ScanOptions, type ScanPage } from "./build";

export type Request = { pages: ScanPage[]; opts: ScanOptions };
export type Reply = ProgressReply | { type: "done"; bytes: Uint8Array } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const bytes = await buildScanPdf(data.pages, data.opts, (fraction, label) => scope.postMessage({ type: "progress", fraction, label }));
    scope.postMessage({ type: "done", bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
