"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ENTER } from "@/components/motion/primitives";
import { describeSize, layout, paperName, readOptions, type Sheet, type Unit } from "@/lib/pdf/resize/geometry";
import { friendlyPdfError } from "@/lib/pdf/errors";

/** The preview's longest side on screen, in CSS pixels. */
const BOX = 220;

/** The first pages of the file, drawn once, and how big each is as shown. */
interface Source {
  count: number;
  pages: { width: number; height: number; image: HTMLCanvasElement }[];
}

/**
 * The first sheet of the result for the chosen options, drawn from the
 * first pages of the file with the same layout the tool uses. The pages are
 * drawn once with pdf.js; changing an option only lays them out again.
 */
export function ResizePreview({ file, options }: { file: File; options: Record<string, string> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let loaded: { destroy: () => void } | null = null;
    let made: Source | null = null;
    setSource(null);
    setFailed(null);
    (async () => {
      const { loadForRender } = await import("@/lib/pdf/render");
      const pdf = await loadForRender(await file.arrayBuffer());
      loaded = pdf;
      // The same words the tool says when cast.
      if (!pdf.numPages) throw new Error("This PDF has no pages.");
      const pages: Source["pages"] = [];
      // Enough pages for the fullest sheet (4 a sheet).
      for (let i = 1; i <= Math.min(4, pdf.numPages) && live; i++) {
        const vp = await pdf.getPageViewport(i, 1);
        const image = document.createElement("canvas");
        // Twice the box, for sharp screens.
        await pdf.renderPage(i, image, (BOX * 2) / Math.max(vp.baseWidth, vp.baseHeight, 1), { pixelRatio: 1 });
        pages.push({ width: vp.baseWidth, height: vp.baseHeight, image });
      }
      made = { count: pdf.numPages, pages };
      // The pictures are drawn; the document itself isn't needed any more.
      pdf.destroy();
      loaded = null;
      if (live) setSource(made);
    })().catch((err) => {
      if (live) setFailed(friendlyPdfError(err).message);
    });
    return () => {
      live = false;
      loaded?.destroy();
      // Let go of the page pictures now, not at some later collection.
      for (const page of made?.pages ?? []) page.image.width = page.image.height = 0;
    };
  }, [file]);

  // Laid out again only when an option changes, not on every progress tick.
  const { sheet, problem, unit } = useMemo((): { sheet: Sheet | null; problem: string | null; unit: Unit } => {
    const unit: Unit =
      options.size === "custom" && (options.unit === "in" || options.unit === "pt")
        ? options.unit
        : ["letter", "legal", "tabloid"].includes(options.size)
          ? "in"
          : "mm";
    if (!source) return { sheet: null, problem: null, unit };
    try {
      const opts = readOptions(options);
      return { sheet: layout(source.pages.slice(0, opts.perSheet), opts)[0], problem: null, unit };
    } catch (err) {
      return { sheet: null, problem: (err as Error).message, unit };
    }
  }, [source, options]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sheet || !source) return;
    const scale = BOX / Math.max(sheet.width, sheet.height);
    const w = Math.max(1, Math.round(sheet.width * scale));
    const h = Math.max(1, Math.round(sheet.height * scale));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    // PDF space runs up from the bottom; the canvas runs down from the top.
    const top = (y: number, height: number) => sheet.height - y - height;
    for (const placed of sheet.pages) {
      const page = source.pages[placed.page];
      ctx.save();
      ctx.beginPath();
      ctx.rect(placed.clip.x, top(placed.clip.y, placed.clip.height), placed.clip.width, placed.clip.height);
      ctx.clip();
      const pw = page.width * placed.scale;
      const ph = page.height * placed.scale;
      ctx.drawImage(page.image, placed.x, top(placed.y, ph), pw, ph);
      ctx.restore();
    }
  }, [sheet, source]);

  const first = source?.pages[0];
  const perSheet = Number(options.perSheet) || 1;
  const sheets = source ? Math.ceil(source.count / perSheet) : 0;
  const lastOnSheet = source ? Math.min(perSheet, source.count) : 0;
  const named = (width: number, height: number) => {
    const paper = paperName(width, height);
    return `${paper ? `${paper}, ` : ""}${describeSize(width, height, unit)}`;
  };
  const size = sheet ? `${named(sheet.width, sheet.height)}, ${sheet.width > sheet.height ? "landscape" : "portrait"}` : "";
  const label = !source
    ? ""
    : perSheet > 1
      ? `Sheet 1 of ${sheets}: ${lastOnSheet > 1 ? `pages 1–${lastOnSheet}` : "page 1"}`
      : `Page 1 of ${source.count}`;
  const from = first ? named(first.width, first.height) : "";

  // Read out once typing stops, not at every keystroke.
  const words = failed ?? problem ?? (sheet ? `Preview: ${label}, ${perSheet > 1 ? "" : `${from} to `}${size}.` : "");
  const [spoken, setSpoken] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSpoken(words), 700);
    return () => clearTimeout(t);
  }, [words]);

  return (
    <motion.div
      initial={ENTER.initial}
      animate={ENTER.animate}
      className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center"
    >
      <div className="flex h-[236px] w-full max-w-[236px] shrink-0 items-center justify-center rounded-xl bg-secondary/60">
        {sheet ? (
          <canvas ref={canvasRef} role="img" aria-label={`Preview: ${label} on ${size}`} className="rounded-[2px] shadow-md ring-1 ring-black/10" />
        ) : (
          <p className="px-4 text-center text-xs text-muted-foreground">
            {failed ?? problem ?? "Drawing a preview…"}
          </p>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
      <div className="min-w-0 text-center text-sm sm:text-left">
        <p className="font-medium">Preview</p>
        {sheet && (
          <>
            <p className="mt-1 text-muted-foreground">{label}</p>
            <p className="mt-1 text-muted-foreground">
              {perSheet > 1 ? "" : `${from} → `}
              {size}
            </p>
            {source && source.count > 1 && perSheet === 1 && (
              <p className="mt-1 text-xs text-muted-foreground">Every page gets this size.</p>
            )}
          </>
        )}
      </div>
    </motion.div>
  );
}
