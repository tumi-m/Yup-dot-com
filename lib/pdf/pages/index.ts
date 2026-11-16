/**
 * Writes the new PDF for Organize PDF, Delete pages and Extract pages from
 * the page list the person put together (./plan.ts).
 *
 * Organize and Delete change the first file in place, as the editor's page
 * operations do: its form, bookmarks, links, title and attachments stay, and
 * what only the pages left out use goes with them. Extract copies the picked
 * pages out into a new document, as Split does, so nothing of the other
 * pages comes along.
 */
import type { PDFDocument } from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { friendlyPdfError } from "../errors";
import { openPdf } from "../open";
import { composePages, extractFrom, type ComposedPage } from "../operations";
import type { PagesMode, PlanItem } from "./plan";

export interface BuildOptions {
  mode: PagesMode;
  /** The files' names, for errors that say which file is the problem. */
  names?: string[];
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

export async function buildPages(sources: Uint8Array[], plan: PlanItem[], opts: BuildOptions): Promise<Uint8Array> {
  const { mode, onProgress, signal } = opts;
  if (!plan.length) throw new Error(mode === "extract" ? "Pick the pages to extract." : "Keep at least one page.");
  if (mode !== "organize" && plan.some((p) => p.kind !== "page" || p.source !== 0 || p.rotate)) {
    throw new Error("Invalid page order.");
  }
  // Only the files the plan uses are read.
  const used = new Set(plan.flatMap((p) => (p.kind === "page" ? [p.source] : [])));
  used.add(0);
  const docs: PDFDocument[] = [];
  for (let s = 0; s < sources.length; s++) {
    stopIfAborted(signal);
    if (!used.has(s)) continue;
    onProgress?.(0.05 + (0.3 * s) / sources.length, used.size > 1 ? `Reading file ${s + 1} of ${sources.length}…` : "Reading the PDF…");
    try {
      docs[s] = await openPdf(sources[s]);
    } catch (err) {
      throw friendlyPdfError(err, used.size > 1 ? opts.names?.[s] : undefined);
    }
  }
  stopIfAborted(signal);
  onProgress?.(0.4, mode === "extract" ? "Copying pages…" : "Arranging pages…");
  let out: Uint8Array;
  try {
    out =
      mode === "extract"
        ? await extractFrom(docs[0], plan.map((p) => (p as { page: number }).page))
        : await composePages(
            docs,
            plan.map((p): ComposedPage =>
              p.kind === "blank"
                ? { blank: { width: p.width, height: p.height }, rotate: p.rotate }
                : { source: p.source, page: p.page, rotate: p.rotate }
            )
          );
  } catch (err) {
    throw friendlyPdfError(err);
  }
  stopIfAborted(signal);
  return out;
}
