/**
 * Runs redactPdf in a Web Worker so the page stays responsive on long
 * documents (see off-thread.ts), and makes the widened copy the text is read
 * from.
 */
import type { ProgressReply } from "../../worker-job";
import { friendlyPdfError } from "../errors";
import { redactPdf, widenBoxes, type RedactJob, type RedactReport } from "./index";

export type Request = { bytes: Uint8Array; job: RedactJob } | { bytes: Uint8Array; widen: true };
export type Reply = ProgressReply | { type: "done"; bytes: Uint8Array; report: RedactReport } | { type: "wide"; bytes: Uint8Array } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    if ("widen" in data) {
      const bytes = await widenBoxes(data.bytes);
      scope.postMessage({ type: "wide", bytes }, [bytes.buffer as ArrayBuffer]);
      return;
    }
    const { bytes, report } = await redactPdf(data.bytes, data.job, (fraction, label) => scope.postMessage({ type: "progress", fraction, label }));
    scope.postMessage({ type: "done", bytes, report }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    // Only a message crosses over, so it is made one for people here.
    scope.postMessage({ type: "error", message: friendlyPdfError(err).message });
  }
};
