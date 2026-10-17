/**
 * Runs compressPdf in a Web Worker so the page stays responsive while images
 * are decoded, resized and encoded (see off-thread.ts).
 */
import { CodecUnavailableError } from "./images";
import { UnreadablePdfError, compressPdf, type Preset } from "./index";

export type Request = { bytes: Uint8Array; preset: Preset };
export type Reply =
  | { type: "progress"; fraction: number; label: string }
  | { type: "done"; bytes: Uint8Array }
  | { type: "error"; kind: "unreadable" | "codec" | "other"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const bytes = await compressPdf(data.bytes, {
      preset: data.preset,
      onProgress: (fraction, label) => scope.postMessage({ type: "progress", fraction, label }),
    });
    scope.postMessage({ type: "done", bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    const kind = err instanceof UnreadablePdfError ? "unreadable" : err instanceof CodecUnavailableError ? "codec" : "other";
    scope.postMessage({ type: "error", kind, message: err instanceof Error ? err.message : String(err) });
  }
};
