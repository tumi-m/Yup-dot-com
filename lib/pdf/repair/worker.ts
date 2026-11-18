/**
 * Runs the pdf-lib parts of a repair in a Web Worker, so reading, checking
 * and rewriting a long or badly damaged file never freezes the page (see
 * off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { friendlyPdfError } from "../errors";
import { NothingRecoveredError, rebuildPdf, splicePictures, type Extras, type Rebuilt } from "./rebuild";
import { NotAPdfError } from "./salvage";

export type Request =
  | { op: "rebuild"; bytes: Uint8Array }
  | { op: "splice"; vector: Uint8Array; pictures: Uint8Array | null; placed: number[]; empty: number[] };
export type Reply =
  | ProgressReply
  | { type: "rebuilt"; result: Rebuilt }
  | { type: "spliced"; bytes: Uint8Array; after: Extras; pages: number }
  | { type: "error"; kind: "nothing" | "other"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

/** The buffers of a result, handed back rather than copied. */
function buffersOf(result: Rebuilt): ArrayBuffer[] {
  const list = result.kind === "done" ? [result.bytes] : result.kind === "pictures" ? [result.vector, result.render] : [result.bytes];
  return [...new Set(list.map((b) => b.buffer as ArrayBuffer))];
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.op === "rebuild") {
      const result = await rebuildPdf(data.bytes, {
        onProgress: (fraction, label) => scope.postMessage({ type: "progress", fraction, label }),
      });
      scope.postMessage({ type: "rebuilt", result }, buffersOf(result));
    } else {
      const out = await splicePictures(data.vector, data.pictures, data.placed, data.empty);
      scope.postMessage({ type: "spliced", ...out }, [out.bytes.buffer as ArrayBuffer]);
    }
  } catch (err) {
    // Messages for people, made here: the error's name doesn't cross over.
    const nothing = err instanceof NothingRecoveredError || err instanceof NotAPdfError;
    scope.postMessage({ type: "error", kind: nothing ? "nothing" : "other", message: nothing ? (err as Error).message : friendlyPdfError(err).message });
  }
};
