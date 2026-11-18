/**
 * What a comparison gives to download: the report, and each file with its
 * changes marked (see mark.ts). Written one after the other, so only one
 * file is open in pdf-lib at a time.
 */
import { friendlyPdfError } from "../errors";
import type { FontFiles } from "../text-to-pdf/fonts";
import type { CompareResult } from "./index";
import { markPdf } from "./mark";
import { makeReport } from "./report";
import type { ReadDocument } from "./words";

export interface ExportJob {
  a: { bytes: Uint8Array; name: string; doc: ReadDocument };
  b: { bytes: Uint8Array; name: string; doc: ReadDocument };
  result: CompareResult;
  /** The day, as the report prints it. */
  date: string;
}

export interface Exports {
  report: Uint8Array;
  /** Null when there is nothing to mark, or the file couldn't be written. */
  markedA: Uint8Array | null;
  markedB: Uint8Array | null;
  /** Files with changes that couldn't be marked (pdf-lib can't rewrite them), with why. */
  unmarked: { side: "a" | "b"; message: string }[];
}

export async function writeExports(job: ExportJob, fonts: FontFiles, onProgress?: (fraction: number, label: string) => void): Promise<Exports> {
  const { a, b, result } = job;
  onProgress?.(0, "Writing the report…");
  const report = await makeReport(result, { a: a.name, b: b.name, pagesA: a.doc.pages.length, pagesB: b.doc.pages.length }, job.date, fonts);
  if (!result.changes.length) return { report, markedA: null, markedB: null, unmarked: [] };
  const unmarked: Exports["unmarked"] = [];
  // A file pdf.js reads but pdf-lib can't rewrite still gets its report.
  const mark = async (side: "a" | "b") => {
    const { bytes, doc } = job[side];
    try {
      return await markPdf(bytes, side, result.changes, doc);
    } catch (err) {
      unmarked.push({ side, message: friendlyPdfError(err).message });
      return null;
    }
  };
  onProgress?.(0.4, "Marking the original…");
  const markedA = await mark("a");
  onProgress?.(0.7, "Marking the changed version…");
  const markedB = await mark("b");
  onProgress?.(1, "Saving…");
  return { report, markedA, markedB, unmarked };
}
