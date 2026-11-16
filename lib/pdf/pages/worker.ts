/**
 * Runs buildPages in a Web Worker so a long document is read, rearranged and
 * written without freezing the page (see off-thread.ts).
 */
import type { ProgressReply } from "../../worker-job";
import { buildPages } from "./index";
import type { PagesMode, PlanItem } from "./plan";

export type Request = { files: File[]; plan: PlanItem[]; mode: PagesMode };
export type Reply = ProgressReply | { type: "done"; bytes: Uint8Array } | { type: "error"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data }) => {
  try {
    const sources = await Promise.all(data.files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
    const bytes = await buildPages(sources, data.plan, {
      mode: data.mode,
      names: data.files.map((f) => f.name),
      onProgress: (fraction, label) => scope.postMessage({ type: "progress", fraction, label }),
    });
    scope.postMessage({ type: "done", bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
