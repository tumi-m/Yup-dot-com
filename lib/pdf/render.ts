"use client";

// The legacy build, for Safari before 17.4 and older iPhones (see worker.ts).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { configureWorker } from "./worker";
import { ownText, paints, showsPictures } from "./page-content";
import type { OwnText } from "./ocr-layer";

function ensureWorker() {
  configureWorker(pdfjsLib);
}

/**
 * Conservative limits that hold across desktop and mobile browsers. iOS
 * Safari leaves a canvas of more than 4096 x 4096 pixels blank.
 */
const MAX_CANVAS_SIDE = 8192;
const MAX_CANVAS_PIXELS = 4096 * 4096;

/**
 * The pixel ratio to render a page of `width` × `height` CSS pixels at:
 * `wanted`, or less to stay within the canvas limits. The page keeps its
 * size on screen and only looks a little softer.
 */
export function canvasRatio(width: number, height: number, wanted: number): number {
  const fit = Math.min(
    MAX_CANVAS_SIDE / (width * wanted),
    MAX_CANVAS_SIDE / (height * wanted),
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height * wanted * wanted))
  );
  return wanted * Math.min(1, fit);
}

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
  /** The page's own text pieces and where they sit, in displayed points from the top-left. */
  ownText: (pageNumber: number) => Promise<OwnText[]>;
  /** True when the page shows a picture big enough to hold words. */
  showsPictures: (pageNumber: number) => Promise<boolean>;
  /** True when the page draws anything at all, its fields included. */
  paints: (pageNumber: number) => Promise<boolean>;
  /** How many bookmarks and form fields the document has, as pdf.js reads them. */
  extras: () => Promise<{ bookmarks: number; fields: number }>;
  /** Drops what pdf.js keeps of a page once it is done with (decoded pictures, fonts). */
  release: (pageNumber: number) => Promise<void>;
  destroy: () => void;
}

/** Load a PDF for client-side rendering with pdf.js. */
export async function loadForRender(data: ArrayBuffer | Uint8Array): Promise<LoadedPdf> {
  ensureWorker();
  // pdf.js transfers/detaches the buffer, so hand it a private copy.
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;

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
        const dpr = canvasRatio(viewport.width, viewport.height, opts?.pixelRatio ?? screen);
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
    async ownText(pageNumber) {
      return ownText(await doc.getPage(pageNumber));
    },
    async showsPictures(pageNumber) {
      const page = await doc.getPage(pageNumber);
      try {
        return await showsPictures(page, pdfjsLib.OPS as unknown as Record<string, number>);
      } finally {
        // Drop the decoded pictures now; pages to read are rendered afresh.
        page.cleanup();
      }
    },
    async paints(pageNumber) {
      const page = await doc.getPage(pageNumber);
      return paints(page, pdfjsLib.OPS as unknown as Record<string, number>);
    },
    async extras() {
      const count = (items: { items?: unknown[] }[] | null): number =>
        (items ?? []).reduce((n, item) => n + 1 + count((item.items as { items?: unknown[] }[]) ?? []), 0);
      const [outline, fields] = await Promise.all([doc.getOutline().catch(() => null), doc.getFieldObjects().catch(() => null)]);
      return { bookmarks: count(outline), fields: Object.keys(fields ?? {}).length };
    },
    async release(pageNumber) {
      (await doc.getPage(pageNumber)).cleanup();
    },
    destroy() {
      doc.destroy();
    },
  };
}
