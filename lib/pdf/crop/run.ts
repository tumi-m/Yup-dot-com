/**
 * One Crop PDF job from start to finish: the margins for each page (typed
 * or drawn, or found by trimming white margins), pictures of the areas kept
 * when what's outside is to be removed, then the file written in a worker.
 * The first two need pdf.js and a canvas, so they run in the page, a page
 * at a time; the writing doesn't.
 */
import { isAbort } from "../../abort";
import { friendlyPdfError } from "../errors";
import { TooManyPixelsError } from "../raster";
import type { LoadedPdf } from "../render";
import type { CropReport } from "./index";
import type { CanvasOptions } from "./pictures";
import type { Margins } from "./geometry";

export interface CropSettings {
  /** The pages to crop, 0-indexed. */
  pages: number[];
  /** The same margins on every page, or trim each page to its content plus `padding` points. */
  cut: { margins: Margins } | { trim: { padding: number } };
  /** Margins already found for some pages (by the preview), so they aren't looked for again. */
  found?: Map<number, Margins | null>;
  /** Rebuild the cropped pages from pictures, so what was outside leaves the file. */
  remove?: { dpi: number; keepText: boolean };
}

/** Trim found nothing to cut on any of the pages. */
export class NothingToTrimError extends Error {
  constructor() {
    super("No white margins to trim on these pages.");
  }
}

export async function cropDocument(
  file: Blob,
  settings: CropSettings,
  opts: CanvasOptions & { loaded?: LoadedPdf }
): Promise<{ bytes: Uint8Array; report: CropReport; skipped: number }> {
  const { progress, signal } = opts;
  const trim = "trim" in settings.cut ? settings.cut.trim : null;
  // Rough shares of the time each stage takes.
  const stages = [trim ? 2 : 0, settings.remove ? 4 : 0, 1];
  const total = stages.reduce((a, b) => a + b, 0);
  const stage = (i: number) => {
    const from = stages.slice(0, i).reduce((a, b) => a + b, 0) / total;
    const span = stages[i] / total;
    return (fraction: number, label: string) => progress?.(from + span * Math.max(0, Math.min(1, fraction)), label);
  };

  let loaded = opts.loaded;
  let own: LoadedPdf | undefined;
  const pdf = async () => {
    if (loaded) return loaded;
    const { loadForRender } = await import("../render");
    own = loaded = await loadForRender(new Uint8Array(await file.arrayBuffer()));
    return loaded;
  };
  try {
    let crops: { page: number; margins: Margins }[];
    if (trim) {
      const todo = settings.pages.filter((p) => !settings.found?.has(p));
      const { findMargins } = await import("./pictures");
      const found = todo.length ? await findMargins(await pdf(), todo, { ...opts, padding: trim.padding, progress: stage(0) }) : new Map();
      crops = settings.pages.flatMap((page) => {
        const margins = settings.found?.has(page) ? settings.found.get(page) : found.get(page);
        return margins ? [{ page, margins }] : [];
      });
      if (!crops.length) throw new NothingToTrimError();
    } else {
      const { margins } = settings.cut as { margins: Margins };
      crops = settings.pages.map((page) => ({ page, margins }));
    }
    let pictures;
    if (settings.remove) {
      const { pictureAreas } = await import("./pictures");
      pictures = await pictureAreas(await pdf(), crops, { ...opts, ...settings.remove, progress: stage(1) });
    }
    // The pages are drawn: pdf.js can let go of the file before it is written.
    own?.destroy();
    own = undefined;
    const { cropFile } = await import("./off-thread");
    const done = await cropFile(file, { crops, pictures }, stage(2), signal);
    return { ...done, skipped: settings.pages.length - crops.length };
  } catch (err) {
    if (isAbort(err) || err instanceof NothingToTrimError) throw err;
    if (err instanceof TooManyPixelsError) {
      const lower = !!settings.remove && settings.remove.dpi > 100;
      throw new Error(
        `These pages are too big to turn into pictures here. ${lower ? "Pick a lower resolution, or crop" : "Crop"} fewer pages at once.`
      );
    }
    throw friendlyPdfError(err);
  } finally {
    own?.destroy();
  }
}
