/**
 * One Redact PDF job from start to finish: pictures of the marked pages
 * with the marks painted in (pdf.js and a canvas, in the page), the file
 * rebuilt, cleaned and searched in a worker, then opened again with pdf.js
 * and checked. A file in which any redacted text survives is never
 * returned: RedactionLeakError says what was found.
 */
import { isAbort, stopIfAborted } from "../../abort";
import { friendlyPdfError } from "../errors";
import { TooManyPixelsError } from "../raster";
import type { LoadedPdf } from "../render";
import type { CanvasOptions } from "../crop/pictures";
import type { RedactReport } from "./index";
import { clampRect, type Mark, type Needle, type PageText, type Rect } from "./marks";
import type { Leak } from "./scan";
import { leakMessage } from "./verify";

export interface RedactSettings {
  /** The marks; only ticked ones are applied. */
  marks: Mark[];
  /** What the marks take away, with the copies left on purpose (planNeedles). */
  needles: Needle[];
  /** Picture resolution of rebuilt pages. */
  dpi: number;
  /** Keep the rest of each rebuilt page's text searchable. */
  keepText: boolean;
}

/** The result still held redacted text, so it was thrown away. */
export class RedactionLeakError extends Error {
  constructor(readonly leaks: Leak[]) {
    super(leakMessage(leaks));
  }
}

const loadPdf = async (bytes: Uint8Array) => (await import("../render")).loadForRender(bytes);

/** The text of the given pages (all by default), read once for searching and checking. */
export async function readText(
  loaded: LoadedPdf,
  opts: { pages?: number[]; have?: Map<number, PageText>; progress?: (fraction: number, label: string) => void; signal?: AbortSignal } = {}
): Promise<Map<number, PageText>> {
  const out = opts.have ?? new Map<number, PageText>();
  const pages = opts.pages ?? Array.from({ length: loaded.numPages }, (_, i) => i);
  const todo = pages.filter((p) => !out.has(p));
  for (const [k, page] of todo.entries()) {
    stopIfAborted(opts.signal);
    if (k % 10 === 0) opts.progress?.(k / todo.length, `Reading page ${page + 1}…`);
    out.set(page, await loaded.pageText(page + 1));
    // Text is all that is wanted: pdf.js can let go of the page's fonts and pictures.
    if (k % 20 === 19) {
      await loaded.release(page + 1);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  return out;
}

export async function redactDocument(
  file: Blob,
  settings: RedactSettings,
  opts: CanvasOptions & { loaded?: LoadedPdf; quality?: number; maxPixels?: number }
): Promise<{ bytes: Uint8Array; report: RedactReport }> {
  const { progress, signal } = opts;
  // Rough shares of the time each stage takes.
  const stages = [5, 2, 2];
  const stage = (i: number) => {
    const from = stages.slice(0, i).reduce((a, b) => a + b, 0) / 9;
    return (fraction: number, label: string) => progress?.(from + (stages[i] / 9) * Math.max(0, Math.min(1, fraction)), label);
  };
  let loaded = opts.loaded;
  let own: LoadedPdf | undefined;
  try {
    if (!loaded) own = loaded = await loadPdf(new Uint8Array(await file.arrayBuffer()));
    const byPage = new Map<number, Rect[]>();
    for (const m of settings.marks) {
      if (!m.on || m.page < 0 || m.page >= loaded.numPages) continue;
      const vp = await loaded.getPageViewport(m.page + 1, 1);
      const rects = m.rects.map((r) => clampRect(r, vp.width, vp.height)).filter((r) => r.x1 - r.x0 > 0.1 && r.y1 - r.y0 > 0.1);
      if (rects.length) byPage.set(m.page, [...(byPage.get(m.page) ?? []), ...rects]);
    }
    if (!byPage.size) throw new Error("Mark something to redact first.");
    const marked = [...byPage].sort((a, b) => a[0] - b[0]).map(([page, rects]) => ({ page, rects }));
    const pageCount = loaded.numPages;

    const { redactPictures } = await import("./pictures");
    const pages = await redactPictures(loaded, marked, { ...opts, dpi: settings.dpi, keepText: settings.keepText, needles: settings.needles, progress: stage(0) });
    // The pages are drawn: pdf.js can let go of the file before it is written.
    own?.destroy();
    own = undefined;

    const { redactFile } = await import("./off-thread");
    const done = await redactFile(file, { pages, needles: settings.needles }, stage(1), signal);
    if (done.report.leaks.length) throw new RedactionLeakError(done.report.leaks);

    // Opened again as a reader would, before anyone can have it.
    const check = stage(2);
    check(0, "Checking the result…");
    const result = await loadPdf(done.bytes);
    try {
      const { verifyRedaction } = await import("./verify");
      const leaks = await verifyRedaction(result, { pageCount, marked, needles: settings.needles }, { ...opts, progress: check });
      if (leaks.length) throw new RedactionLeakError(leaks);
    } finally {
      result.destroy();
    }
    return done;
  } catch (err) {
    if (isAbort(err) || err instanceof RedactionLeakError) throw err;
    if (err instanceof TooManyPixelsError) {
      throw new Error(`These pages are too big to turn into pictures here. ${settings.dpi > 100 ? "Pick a lower resolution, or redact" : "Redact"} fewer pages at once.`);
    }
    throw friendlyPdfError(err);
  } finally {
    own?.destroy();
  }
}
