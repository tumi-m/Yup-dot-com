/**
 * Runs the pdf-lib part of PDF to PDF/A in a Web Worker, so reading, fixing
 * and saving a long document never freezes the page (see off-thread.ts).
 */
import { friendlyPdfError } from "../errors";
import { PasswordError, finishPdfa, preparePdfa, type PdfaFacts, type PdfaResult, type Prepared } from "./convert";
import { vendorFonts } from "./fonts";
import type { Part } from "./metadata";

export type Request =
  | { op: "prepare"; bytes: Uint8Array; part: Part; password?: string }
  | { op: "finish"; vector: Uint8Array; pictures: Uint8Array; facts: PdfaFacts };
export type Reply =
  | { type: "progress"; fraction: number; label: string }
  | { type: "prepared"; prepared: Prepared }
  | { type: "finished"; result: PdfaResult }
  | { type: "error"; kind: "password" | "other"; message: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

const onProgress = (fraction: number, label: string) => scope.postMessage({ type: "progress", fraction, label });

scope.onmessage = async ({ data }) => {
  try {
    if (data.op === "prepare") {
      const prepared = await preparePdfa(data.bytes, { part: data.part, password: data.password, fonts: vendorFonts, onProgress });
      const buffer = prepared.kind === "done" ? prepared.result.bytes.buffer : prepared.vector.buffer;
      scope.postMessage({ type: "prepared", prepared }, [buffer as ArrayBuffer]);
    } else {
      const result = await finishPdfa(data.vector, data.pictures, data.facts, { part: data.facts.part, onProgress });
      scope.postMessage({ type: "finished", result }, [result.bytes.buffer as ArrayBuffer]);
    }
  } catch (err) {
    // Messages for people, made here: the error's name doesn't cross over.
    const password = err instanceof PasswordError;
    scope.postMessage({ type: "error", kind: password ? "password" : "other", message: password ? (err as Error).message : friendlyPdfError(err).message });
  }
};
