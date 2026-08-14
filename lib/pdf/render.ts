"use client";

import * as pdfjsLib from "pdfjs-dist";
import { configureWorker } from "./worker";

function ensureWorker() {
  configureWorker(pdfjsLib);
}

export interface LoadedPdf {
  numPages: number;
  getPageViewport: (
    pageNumber: number,
    scale: number
  ) => Promise<{ width: number; height: number; scale: number; baseWidth: number; baseHeight: number }>;
  renderPage: (
    pageNumber: number,
    canvas: HTMLCanvasElement,
    scale: number
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
    async renderPage(pageNumber, canvas, scale) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      await page.render({ canvasContext: ctx, viewport }).promise;
    },
    destroy() {
      doc.destroy();
    },
  };
}
