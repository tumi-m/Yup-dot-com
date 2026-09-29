"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Download,
  EyeOff,
  Loader2,
  Presentation,
  RotateCcw,
  Sparkles,
  Timer,
  UploadCloud,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EASE, SPRING, SparkleBurst } from "@/components/motion/primitives";
import { UpgradeDialog, UpsellCard, type UpsellReason } from "@/components/upsell/Upsell";
import { SlideView } from "@/components/slides/SlideView";
import { downloadBlob } from "@/lib/download";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, setHandoff, takeHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { getTool } from "@/lib/tools";
import { cn, formatBytes } from "@/lib/utils";
import type { Deck, DeckSlide } from "@/lib/pptx/parse";

const SLUG = "pptx-to-pdf";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const NEXT_STEPS = ["compress-pdf", "edit-pdf", "sign-pdf"];

type Status = "idle" | "reading" | "ready" | "working" | "done";

function isPptxName(name: string) {
  return /\.(pptx|ppsx|potx)$/i.test(name);
}

function pdfName(name: string) {
  return `${name.replace(/\.(pptx|ppsx|potx)$/i, "") || "slides"}.pdf`;
}

/** A slide thumbnail that scales itself to the width it is given. */
function Thumb({ slide, deck }: { slide: DeckSlide; deck: Deck }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      className="relative w-full overflow-hidden rounded-lg border border-border bg-white shadow-sm"
      style={{ aspectRatio: `${deck.width} / ${deck.height}` }}
    >
      {width > 0 && (
        <SlideView
          slide={slide}
          deckWidth={deck.width}
          deckHeight={deck.height}
          scale={width / deck.width}
          themeColors={deck.themeColors}
          className={cn(slide.hidden && "opacity-40")}
        />
      )}
    </div>
  );
}

export function PptxToPdf({ tier }: { tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const job = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function open(list: FileList | File[] | null) {
    const picked = list?.length ? Array.from(list)[0] : null;
    if (!picked) return;
    setError(null);
    if (!isPptxName(picked.name) && picked.type !== PPTX_MIME) {
      setError(/\.ppt$/i.test(picked.name) ? "Save it as .pptx first." : "Choose a .pptx file.");
      return;
    }
    if (picked.size > limits.maxFileBytes) {
      setUpsell("file-size");
      setError(`Files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return;
    }
    const id = ++job.current;
    setFile(picked);
    setDeck(null);
    setResult(null);
    setStatus("reading");
    try {
      const { parsePptx } = await import("@/lib/pptx/parse");
      const parsed = await parsePptx(await picked.arrayBuffer());
      if (id !== job.current) return;
      setDeck(parsed);
      setStatus("ready");
    } catch (err) {
      if (id !== job.current) return;
      const { pptxErrorMessage } = await import("@/lib/pptx/parse");
      setError(pptxErrorMessage(err));
      setFile(null);
      setStatus("idle");
    }
  }

  async function convert() {
    if (!deck || !file) return;
    setStatus("working");
    setError(null);
    setProgress({ done: 0, total: deck.slides.filter((s) => !s.hidden).length || deck.slides.length });
    const controller = new AbortController();
    abort.current = controller;
    const started = performance.now();
    try {
      const { deckToPdf } = await import("@/lib/pptx/to-pdf");
      const bytes = await deckToPdf(deck, {
        signal: controller.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setResult(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
      setElapsed((performance.now() - started) / 1000);
      setStatus("done");
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) setTimeout(() => setUpsell("nudge"), 1600);
    } catch {
      if (controller.signal.aborted) return;
      setError("Couldn't convert this file.");
      setStatus("ready");
    } finally {
      setProgress(null);
      abort.current = null;
    }
  }

  function reset() {
    abort.current?.abort();
    job.current++;
    setFile(null);
    setDeck(null);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function continueWith(nextSlug: string) {
    if (!result || !file) return;
    await setHandoff([await fileToHandoff(result, pdfName(file.name))]);
    router.push(`/tools/${nextSlug}?handoff=1`);
  }

  // A file handed over from the homepage dropzone or another tool.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        const match = handed.find((h) => isPptxName(h.name) || h.type === PPTX_MIME) ?? handed[0];
        if (match) open([handoffToFile(match)]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = deck?.slides.filter((s) => !s.hidden).length ?? 0;
  const hidden = (deck?.slides.length ?? 0) - visible;
  const fraction = progress ? progress.done / Math.max(1, progress.total) : 0;

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        {status === "done" && result && file ? (
          <motion.div
            key="done"
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="relative overflow-hidden rounded-3xl border border-border bg-card p-6 text-center shadow-xl shadow-primary/5 sm:p-10"
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-emerald-400/15 to-transparent" />
            <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
              <SparkleBurst />
              <motion.div
                initial={{ scale: 0, rotate: -40 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ ...SPRING, delay: 0.05 }}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
              >
                <motion.svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                  <motion.path
                    d="M5 12.5l4.5 4.5L19 7.5"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.45, ease: EASE, delay: 0.25 }}
                  />
                </motion.svg>
              </motion.div>
            </div>

            <motion.h2
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.5, ease: EASE }}
              className="relative mt-5 text-2xl font-bold"
            >
              Spell complete
            </motion.h2>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.45 }}
              className="relative mt-3 flex flex-wrap items-center justify-center gap-2 text-xs"
            >
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                <Timer className="h-3 w-3" /> {elapsed < 1 ? `${Math.round(elapsed * 1000)} ms` : `${elapsed.toFixed(1)} s`}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                {visible || deck?.slides.length} page{(visible || deck?.slides.length) === 1 ? "" : "s"} · {formatBytes(result.size)}
              </span>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.55, duration: 0.5, ease: EASE }}
              className="relative mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row"
            >
              <Button
                onClick={() => downloadBlob(result, pdfName(file.name))}
                size="lg"
                className="min-w-44 shadow-lg shadow-primary/25"
                data-testid="download"
              >
                <Download /> Download
              </Button>
              <Button onClick={reset} variant="outline" size="lg">
                <RotateCcw /> Start over
              </Button>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.5, ease: EASE }}
              className="relative mt-8"
            >
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Next</p>
              <div className="flex flex-wrap justify-center gap-2">
                {NEXT_STEPS.map((next) => {
                  const t = getTool(next);
                  if (!t) return null;
                  return (
                    <motion.button
                      key={next}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => continueWith(next)}
                      className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm font-medium transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className={cn("flex h-6 w-6 items-center justify-center rounded-full", t.tint)}>
                        <t.icon className="h-3.5 w-3.5" />
                      </span>
                      {t.name}
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>

            {showCard && (
              <UpsellCard
                tier={tier}
                onDismiss={() => {
                  dismissUpsellCard();
                  setShowCard(false);
                }}
              />
            )}
          </motion.div>
        ) : (
          <motion.div
            key="work"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="space-y-5"
          >
            <input
              ref={inputRef}
              type="file"
              accept={`.pptx,${PPTX_MIME}`}
              className="hidden"
              aria-hidden
              tabIndex={-1}
              data-testid="pptx-input"
              onChange={(e) => {
                open(e.target.files);
                e.target.value = "";
              }}
            />

            {!file ? (
              <motion.div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  open(e.dataTransfer.files);
                }}
                animate={{ scale: dragging ? 1.02 : 1 }}
                transition={SPRING}
                className={cn(
                  "group relative overflow-hidden rounded-3xl border-2 border-dashed bg-card p-10 text-center transition-colors",
                  dragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
                )}
              >
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.10),transparent_60%)] opacity-0 transition-opacity duration-500 group-hover:opacity-100"
                />
                <motion.div
                  animate={dragging ? { y: -6, scale: 1.1 } : { y: [0, -5, 0] }}
                  transition={dragging ? SPRING : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                  className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"
                >
                  <UploadCloud className="h-7 w-7" />
                </motion.div>
                <p className="relative mt-4 text-lg font-semibold">{dragging ? "Release to add" : "Drop a .pptx here"}</p>
                <p className="relative text-sm text-muted-foreground">or</p>
                <Button className="relative mt-3 h-11" onClick={() => inputRef.current?.click()}>
                  Choose file
                </Button>
                <p className="relative mt-4 text-xs text-muted-foreground">Stays on your device.</p>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <Presentation className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                    {deck && ` · ${deck.slides.length} slide${deck.slides.length === 1 ? "" : "s"}`}
                    {hidden > 0 && ` · ${hidden} hidden`}
                  </p>
                </div>
                {status !== "working" && (
                  <button
                    onClick={reset}
                    className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </motion.div>
            )}

            {status === "reading" && (
              <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> Reading slides…
              </p>
            )}

            {deck && status !== "reading" && (
              <motion.ol
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
                aria-label="Slides"
                data-testid="slide-thumbs"
                className="grid max-h-[28rem] grid-cols-2 gap-3 overflow-y-auto rounded-2xl border border-border bg-secondary/40 p-3 sm:grid-cols-3"
              >
                {deck.slides.map((slide) => (
                  <li key={slide.part} className="relative" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 120px" }}>
                    <span className="sr-only">Slide {slide.number}</span>
                    <Thumb slide={slide} deck={deck} />
                    <span aria-hidden className="absolute bottom-1.5 left-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
                      {slide.number}
                    </span>
                    {slide.hidden && (
                      <span
                        className="absolute right-1.5 top-1.5 inline-flex items-center rounded-md bg-black/60 p-1 text-white"
                        title="Hidden, skipped"
                      >
                        <EyeOff className="h-3 w-3" aria-hidden />
                        <span className="sr-only">Hidden, skipped</span>
                      </span>
                    )}
                  </li>
                ))}
              </motion.ol>
            )}

            <AnimatePresence>
              {error && (
                <motion.p
                  role="alert"
                  data-testid="tool-error"
                  initial={{ opacity: 0, x: 0 }}
                  animate={{ opacity: 1, x: [0, -6, 6, -3, 3, 0] }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4 }}
                  className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-foreground"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            {deck && (status === "ready" || status === "working") && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center gap-3"
              >
                {status === "working" ? (
                  <div className="w-full max-w-md" aria-live="polite">
                    <div
                      className="relative h-3 overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                      aria-label="Converting"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(fraction * 100)}
                    >
                      <motion.div
                        className="h-full rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400"
                        animate={{ width: `${Math.max(4, fraction * 100)}%` }}
                        transition={{ ease: "easeOut", duration: 0.3 }}
                      />
                    </div>
                    <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        className="inline-flex"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                      </motion.span>
                      {progress ? `Slide ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Casting…"}
                      <span className="tabular-nums">{Math.round(fraction * 100)}%</span>
                    </p>
                  </div>
                ) : (
                  <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING} tabIndex={-1}>
                    <Button size="lg" onClick={convert} className="min-w-52 shadow-lg shadow-primary/25" data-testid="convert">
                      <Sparkles /> Convert to PDF
                    </Button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {upsell && (
        <UpgradeDialog
          open
          onOpenChange={(o) => !o && setUpsell(null)}
          reason={upsell}
          tier={tier}
          returnTo={`/tools/${SLUG}`}
        />
      )}
    </>
  );
}
