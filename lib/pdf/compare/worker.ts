/**
 * Compare PDFs' heavy steps in a Web Worker, so the page keeps answering
 * (see off-thread.ts): the word diff over two whole documents, then the
 * report and the marked copies written with pdf-lib.
 */
import type { ProgressReply } from "../../worker-job";
import { friendlyPdfError } from "../errors";
import { vendorFonts } from "../text-to-pdf/fonts";
import { compareWords, type CompareResult } from "./index";
import { writeExports, type ExportJob, type Exports } from "./exports";
import type { ReadDocument } from "./words";

export type Request = { op: "diff"; a: ReadDocument; b: ReadDocument } | ({ op: "export" } & ExportJob);
export type Reply =
  | ProgressReply
  | { type: "diffed"; result: CompareResult }
  | { type: "exported"; exports: Exports }
  | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    if (data.op === "diff") {
      scope.postMessage({ type: "diffed", result: compareWords(data.a, data.b) });
      return;
    }
    const exports = await writeExports(data, vendorFonts, (fraction, label) => scope.postMessage({ type: "progress", fraction, label }));
    const buffers = [exports.report, exports.markedA, exports.markedB].flatMap((b) => (b ? [b.buffer as ArrayBuffer] : []));
    scope.postMessage({ type: "exported", exports }, buffers);
  } catch (err) {
    // Only a message crosses over, so it is made one for people here.
    scope.postMessage({ type: "error", message: friendlyPdfError(err).message });
  }
};
