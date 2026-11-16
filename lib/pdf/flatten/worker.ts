/**
 * Runs flattenPdf in a Web Worker so a long document never freezes the page
 * while it is read, flattened and saved (see off-thread.ts).
 */
import { friendlyPdfError } from "../errors";
import { NothingToFlattenError, flattenPdf, type FlattenReport, type FlattenScope } from "./index";

export type Request = { bytes: Uint8Array; scope: FlattenScope };
export type Reply =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; bytes: Uint8Array; report: FlattenReport }
  | { type: "error"; kind: "nothing" | "other"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const { bytes, report } = await flattenPdf(data.bytes, data.scope, {
      onProgress: (fraction, label) => scope.postMessage({ type: "progress", fraction, label }),
    });
    scope.postMessage({ type: "done", bytes, report }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    const kind = err instanceof NothingToFlattenError ? "nothing" : "other";
    // Messages for people, made here: the error's name doesn't cross over.
    scope.postMessage({ type: "error", kind, message: kind === "nothing" ? (err as Error).message : friendlyPdfError(err).message });
  }
};
