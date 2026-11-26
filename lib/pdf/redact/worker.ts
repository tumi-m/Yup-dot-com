/**
 * Runs redactPdf in a Web Worker so the page stays responsive on long
 * documents (see off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { friendlyPdfError } from "../errors";
import { redactPdf, type RedactJob, type RedactReport } from "./index";

export type Request = { bytes: Uint8Array; job: RedactJob };
export type Reply = ProgressReply | { type: "done"; bytes: Uint8Array; report: RedactReport } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const { bytes, report } = await redactPdf(data.bytes, data.job, (fraction, label) => scope.postMessage({ type: "progress", fraction, label }));
    scope.postMessage({ type: "done", bytes, report }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    // Only a message crosses over, so it is made one for people here.
    scope.postMessage({ type: "error", message: friendlyPdfError(err).message });
  }
};
