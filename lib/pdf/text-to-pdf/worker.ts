/**
 * Runs Text and Markdown to PDF in a Web Worker, so a long file is laid out
 * without freezing the page (see off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { vendorFonts } from "./fonts";
import { textToPdf, type TextToPdfOptions } from "./index";
import { markdownToPdf } from "./markdown";

export type Request = { bytes: Uint8Array; name: string; markdown: boolean; opts: Partial<TextToPdfOptions> };
export type Reply = ProgressReply | { type: "done"; bytes: Uint8Array; note?: string } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const convert = data.markdown ? markdownToPdf : textToPdf;
    const out = await convert(data.bytes, data.name, data.opts, vendorFonts, (fraction, label) =>
      scope.postMessage({ type: "progress", fraction, label })
    );
    scope.postMessage({ type: "done", bytes: out.bytes, note: out.note }, [out.bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
