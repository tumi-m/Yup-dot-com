"use client";

import * as pdfjsLib from "pdfjs-dist";
import { configureWorker } from "./worker";

function ensureWorker() {
  configureWorker(pdfjsLib);
}

/** Conservative limits that hold across desktop and mobile browsers. */
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_PIXELS = 8192 * 8192 * 0.5;

const canvasSlots = new WeakMap<
  HTMLCanvasElement,
  { generation: number; task: { cancel: () => void } | null; done: Promise<void> }
>();

export interface LoadedPdf {
  numPages: number;
  getPageViewport: (
    pageNumber: number,
    scale: number
  ) => Promise<{ width: number; height: number; scale: number; baseWidth: number; baseHeight: number }>;
  /**
   * Renders into `canvas`. On-screen callers get devicePixelRatio for crisp
   * output; exports pass `pixelRatio: 1` so the file doesn't depend on the
   * screen it was made on. Very large pages are scaled down to stay within
   * the browser's canvas limits (beyond them the canvas silently stays blank).
   */
  renderPage: (
    pageNumber: number,
    canvas: HTMLCanvasElement,
    scale: number,
    opts?: { pixelRatio?: number }
  ) => Promise<void>;
  destroy: () => void;
}

/** Load a PDF for client-side rendering with pdf.js. */
export async function loadForRender(data: ArrayBuffer | Uint8Array): Promise<LoadedPdf> {
  ensureWorker();
  // pdf.js transfers/detaches the buffer, so hand it a private copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;

  return {
    numPages: doc.numPages,
    async getPageViewport(pageNumber, scale) {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale });
      return {
        width: vp.width,
        height: vp.height,
        scale,
        baseWidth: base.width,
        baseHeight: base.height,
      };
    },
    renderPage(pageNumber, canvas, scale, opts) {
      // pdf.js refuses two renders into one canvas at once (fast zooming,
      // React re-running an effect). Renders of a canvas run one at a time
      // and the newest request wins: older ones are cancelled or skipped.
      const slot = canvasSlots.get(canvas) ?? { generation: 0, task: null, done: Promise.resolve() };
      canvasSlots.set(canvas, slot);
      const generation = ++slot.generation;
      slot.task?.cancel();
      const run = slot.done.then(async () => {
        if (slot.generation !== generation) return;
        const page = await doc.getPage(pageNumber);
        if (slot.generation !== generation) return;
        const viewport = page.getViewport({ scale });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const screen = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        const wanted = opts?.pixelRatio ?? screen;
        const fit = Math.min(
          MAX_CANVAS_SIDE / (viewport.width * wanted),
          MAX_CANVAS_SIDE / (viewport.height * wanted),
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height * wanted * wanted))
        );
        const dpr = wanted * Math.min(1, fit);
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = page.render({ canvasContext: ctx, viewport });
        slot.task = task;
        try {
          await task.promise;
        } catch (err) {
          // Superseded by a newer render of the same canvas: not an error.
          if ((err as { name?: string })?.name === "RenderingCancelledException") return;
          throw err;
        } finally {
          if (slot.task === task) slot.task = null;
        }
      });
      slot.done = run.catch(() => {});
      return run;
    },
    destroy() {
      doc.destroy();
    },
  };
}
