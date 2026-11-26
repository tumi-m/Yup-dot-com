/**
 * Writes Translate PDF's files in a Web Worker, so laying out a long
 * document doesn't freeze the page (see off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { vendorFonts } from "../text-to-pdf/fonts";
import { buildOutputs, type OutputRequest } from "./output";

export type Reply = ProgressReply | { type: "done"; docx: Uint8Array; pdf?: Uint8Array; note?: string } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<OutputRequest>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const out = await buildOutputs(data, vendorFonts, (fraction, label) => scope.postMessage({ type: "progress", fraction, label }));
    const transfer = [out.docx.buffer, ...(out.pdf ? [out.pdf.buffer] : [])] as ArrayBuffer[];
    scope.postMessage({ type: "done", docx: out.docx, pdf: out.pdf, note: out.note }, transfer);
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
