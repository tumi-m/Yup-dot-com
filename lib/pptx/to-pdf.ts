import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { toCanvas } from "html-to-image";
import { SlideView } from "@/components/slides/SlideView";
import { buildSearchablePdf, type OcrPage, type OcrWord } from "@/lib/pdf/ocr-layer";
import type { Deck } from "./parse";

/**
 * Deck -> PDF, entirely in the browser (browser-only module; import it
 * dynamically from client code).
 *
 * Each slide is rendered with <SlideView> into one offscreen container,
 * rasterised with html-to-image and encoded as JPEG (slides always have an
 * opaque background, so PNG's alpha is never needed), then its canvas is
 * released before the next slide, so memory stays flat on long decks. Pages
 * are exactly the slide size in points.
 *
 * The words' on-screen boxes are measured while each slide is mounted and
 * written as an invisible text layer (the same one OCR uses, see
 * lib/pdf/ocr-layer.ts), so the PDF can be searched and copied. Limits: text
 * in rotated shapes is left out, and the layer's standard font only encodes
 * Latin-1, so other scripts are image-only.
 */

export interface DeckPdfOptions {
  /** Canvas pixels per point (default 2, i.e. ~144 dpi). */
  pixelRatio?: number;
  /** JPEG quality (default 0.92). */
  quality?: number;
  /** Include slides hidden in PowerPoint (default false, like PowerPoint's export). */
  includeHidden?: boolean;
  /** Add an invisible, searchable text layer (default true). */
  textLayer?: boolean;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Keeps the longest side under what every browser can allocate. */
const MAX_CANVAS_SIDE = 4096;

function nextFrame() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

async function imagesReady(root: HTMLElement) {
  const imgs = Array.from(root.querySelectorAll("img"));
  await Promise.all(imgs.map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : img.decode().catch(() => {}))));
}

/** Measures every word of unrotated slide text, in slide points. */
export function measureWords(slideRoot: HTMLElement, ratio: number): OcrWord[] {
  const origin = slideRoot.getBoundingClientRect();
  const words: OcrWord[] = [];
  const walker = document.createTreeWalker(slideRoot, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    if (!text.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest("[data-bullet]") || parent.closest("svg")) continue;
    if (parent.closest("[data-rotated]")) continue;
    const re = /\S+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = range.getClientRects();
      // A word broken across lines yields several boxes; use the first.
      const r = rects[0];
      if (!r || r.width <= 0 || r.height <= 0) continue;
      words.push({
        text: m[0],
        x0: (r.left - origin.left) * ratio,
        y0: (r.top - origin.top) * ratio,
        x1: (r.right - origin.left) * ratio,
        y1: (r.bottom - origin.top) * ratio,
        confidence: 100,
      });
    }
  }
  range.detach();
  return words;
}

export async function deckToPdf(deck: Deck, opts: DeckPdfOptions = {}): Promise<Uint8Array> {
  const slides = deck.slides.filter((s) => opts.includeHidden || !s.hidden);
  const list = slides.length ? slides : deck.slides;
  const quality = opts.quality ?? 0.92;
  const ratio = Math.min(opts.pixelRatio ?? 2, MAX_CANVAS_SIDE / Math.max(deck.width, deck.height));
  const withText = opts.textLayer ?? true;

  // Offscreen but laid out, so fonts, images and text metrics are real.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-${Math.ceil(deck.width) + 200}px;top:0;width:${deck.width}px;height:${deck.height}px;overflow:hidden;pointer-events:none;contain:strict;`;
  document.body.appendChild(host);
  const root = createRoot(host);

  const pages: OcrPage[] = [];
  try {
    await document.fonts?.ready;
    for (let i = 0; i < list.length; i++) {
      if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const slide = list[i];
      flushSync(() =>
        root.render(
          createElement(SlideView, {
            slide,
            deckWidth: deck.width,
            deckHeight: deck.height,
            scale: 1,
            themeColors: deck.themeColors,
          })
        )
      );
      const node = host.firstElementChild as HTMLElement;
      await imagesReady(node);
      await nextFrame();

      const canvas = await toCanvas(node, {
        pixelRatio: ratio,
        width: deck.width,
        height: deck.height,
        backgroundColor: "#FFFFFF",
        skipFonts: true,
        cacheBust: false,
      });
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", quality));
      const imageWidth = canvas.width;
      const imageHeight = canvas.height;
      // Free the backing store now rather than whenever GC runs.
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error("Couldn't render a slide.");

      pages.push({
        widthPt: deck.width,
        heightPt: deck.height,
        image: new Uint8Array(await blob.arrayBuffer()),
        imageType: "jpeg",
        imageWidth,
        imageHeight,
        words: withText ? measureWords(node, imageWidth / deck.width) : [],
      });
      opts.onProgress?.(i + 1, list.length);
    }
  } finally {
    root.unmount();
    host.remove();
  }

  return buildSearchablePdf(pages, { minConfidence: 0 });
}
