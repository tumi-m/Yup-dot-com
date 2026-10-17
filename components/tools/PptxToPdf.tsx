"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Download, EyeOff, Loader2, Presentation, RotateCcw, Sparkles, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import {
  ENTER,
  EXIT,
  FADE_EXIT,
  HANDOFF,
  InlineError,
  NOTICE_T,
  PROGRESS_HOLD_MS,
} from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { SlideView } from "@/components/slides/SlideView";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, setHandoff, takeHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const job = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done">();
  /** Holds the flow's height while the work view and the result swap. */
  const flow = useHeightLock<HTMLDivElement>();

  useEffect(() => () => abort.current?.abort(), []);

  async function open(list: FileList | File[] | null) {
    const picked = list?.length ? Array.from(list)[0] : null;
    if (!picked) return;
    setError(null);
    if (!isPptxName(picked.name) && picked.type !== PPTX_MIME) {
      setError(/\.(ppt|pps|pot|odp|key)$/i.test(picked.name) ? "Save it as .pptx first." : "Choose a .pptx file.");
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
    // The button goes away; the result takes focus if the visitor was here.
    const hadFocus = !!flow.ref.current?.contains(document.activeElement);
    flow.lock(resultFloor());
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
        onProgress: (done, total) => !controller.signal.aborted && setProgress({ done, total }),
      });
      if (controller.signal.aborted) return;
      const seconds = (performance.now() - started) / 1000;
      // Let the bar visibly finish before the result replaces it.
      setProgress((p) => (p ? { done: p.total, total: p.total } : p));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (controller.signal.aborted) return;
      setResult(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
      setElapsed(seconds);
      if (hadFocus || document.activeElement === document.body) focusNext.current = "done";
      settleSlot(flow.ref.current);
      setStatus("done");
      trackToolUsed("pptx-to-pdf");
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch {
      if (controller.signal.aborted) return;
      setError("Couldn't convert this file.");
      setStatus("ready");
    } finally {
      // A cancelled run must not clear the state of one started after it.
      if (abort.current === controller) {
        setProgress(null);
        abort.current = null;
      }
    }
  }

  function cancelConvert() {
    abort.current?.abort();
    abort.current = null;
    setProgress(null);
    setStatus("ready");
  }

  function reset() {
    nudge.cancel();
    flow.lock();
    abort.current?.abort();
    job.current++;
    setFile(null);
    setDeck(null);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function continueWith(nextSlug: string) {
    nudge.cancel();
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
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
      <AnimatePresence mode="wait" initial={false}>
        {status === "done" && result && file ? (
          <SuccessCard
            key="done"
            className="flex-1"
            titleRef={focusRef("done")}
            stats={
              <>
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                  <Timer className="h-3 w-3" /> {elapsed < 1 ? `${Math.round(elapsed * 1000)} ms` : `${elapsed.toFixed(1)} s`}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                  {visible || deck?.slides.length} page{(visible || deck?.slides.length) === 1 ? "" : "s"} · {formatBytes(result.size)}
                </span>
              </>
            }
            actions={
              <>
                <Button
                  onClick={() => {
                    nudge.downloaded();
                    downloadBlob(result, pdfName(file.name));
                  }}
                  size="lg"
                  className="min-w-44 shadow-lg shadow-primary/25"
                  data-testid="download"
                >
                  <Download /> Download
                </Button>
                <Button onClick={reset} variant="outline" size="lg">
                  <RotateCcw /> Start over
                </Button>
              </>
            }
            next={{ slugs: NEXT_STEPS, onPick: (next) => void continueWith(next) }}
            upsell={
              showCard && (
                <UpsellCard
                  tier={tier}
                  onDismiss={() => {
                    dismissUpsellCard();
                    setShowCard(false);
                  }}
                />
              )
            }
          />
        ) : (
          <motion.div
            key="work"
            initial={ENTER.initial}
            animate={ENTER.animate}
            exit={EXIT}
            onAnimationStart={(def) => def !== EXIT && flow.release()}
            className="space-y-5"
          >
            <input
              ref={inputRef}
              type="file"
              accept={`.pptx,${PPTX_MIME}`}
              className="hidden"
              // The attribute (not just the class) keeps it out of space-y.
              hidden
              aria-hidden
              tabIndex={-1}
              data-testid="pptx-input"
              onChange={(e) => {
                open(e.target.files);
                e.target.value = "";
              }}
            />

            {!file ? (
              <ToolDropzone label="Drop a .pptx here" onFiles={open}>
                <p className="text-sm text-muted-foreground">or</p>
                <Button className="mt-3 h-11" onClick={() => inputRef.current?.click()}>
                  Choose file
                </Button>
                <p className="mt-4 text-xs text-muted-foreground">Stays on your device.</p>
              </ToolDropzone>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={ENTER.animate}
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
                <Loader2 className="h-4 w-4 text-primary motion-safe:animate-spin" /> Reading slides…
              </p>
            )}

            {deck && status !== "reading" && (
              <motion.ol
                initial={ENTER.initial}
                animate={ENTER.animate}
                aria-label="Slides"
                data-testid="slide-thumbs"
                // Scrollable with nothing focusable inside: keyboard users scroll it directly.
                tabIndex={0}
                className="grid max-h-[28rem] grid-cols-2 gap-3 overflow-y-auto rounded-2xl border border-border bg-secondary/40 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-3"
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

            <AnimatePresence>{error && <InlineError key="error" message={error} />}</AnimatePresence>

            {deck && (status === "ready" || status === "working") && (
              <motion.div
                initial={ENTER.initial}
                animate={ENTER.animate}
                className="relative flex flex-col items-center gap-3"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                {status === "working" ? (
                  <motion.div
                    key="progress"
                    initial={HANDOFF.in.initial}
                    animate={HANDOFF.in.animate}
                    exit={FADE_EXIT}
                    className="w-full max-w-md"
                  >
                    <motion.div initial={HANDOFF.track.initial} animate={HANDOFF.track.animate}>
                      <ProgressBar value={fraction} determinate label="Converting" />
                    </motion.div>
                    <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                      <WorkingGlyph />
                      <span aria-live="polite" className="inline-flex gap-1.5 tabular-nums">
                        {progress ? `Slide ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : "Casting…"}
                        <ProgressPercent value={fraction} />
                      </span>
                      <Button variant="ghost" size="sm" className="tap ml-1" onClick={cancelConvert} data-testid="cancel-convert">
                        Cancel
                      </Button>
                    </p>
                  </motion.div>
                ) : (
                  <motion.div
                    key="convert"
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1, transition: NOTICE_T }}
                    exit={HANDOFF.out}
                  >
                    <Button size="lg" onClick={convert} className="min-w-52 shadow-lg shadow-primary/25" data-testid="convert">
                      <Sparkles /> Convert to PDF
                    </Button>
                  </motion.div>
                )}
                </AnimatePresence>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      </div>
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
