"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion } from "motion/react";
import {
  File as FileIcon,
  X,
  Download,
  Sparkles,
  GripVertical,
  Eye,
  EyeOff,
  RotateCcw,
  Timer,
  TrendingDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToolDropzone } from "@/components/ui/dropzone";
import { downloadBlob } from "@/lib/download";
import { formatBytes } from "@/lib/utils";
import type { ToolFile } from "@/lib/pdf/toolkit";
import {
  CountUp,
  DUR,
  ENTER,
  ENTER_T,
  EXIT,
  EXIT_T,
  FADE_EXIT,
  InlineError,
  NOTICE_T,
  PROGRESS_HOLD_MS,
  SPRING_LAYOUT,
  SUCCESS,
} from "@/components/motion/primitives";
import { ProgressBar, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { PROCESSORS, type ToolField } from "./processors";
import { SuccessCard } from "./SuccessCard";
import { limitsFor, formatLimitBytes, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, setHandoff, takeHandoff } from "@/lib/local-store";
import { recordTask, upsellCardDismissed, dismissUpsellCard } from "@/lib/nudge";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { friendlyPdfError } from "@/lib/pdf/errors";
import { trackToolUsed } from "@/lib/analytics";

/** Where a finished PDF can go next — Smallpdf-style "keep going" chaining. */
const NEXT_STEPS: Record<string, string[]> = {
  default: ["compress-pdf", "edit-pdf", "sign-pdf", "protect-pdf"],
  "compress-pdf": ["edit-pdf", "protect-pdf", "sign-pdf", "pdf-to-word"],
  "merge-pdf": ["compress-pdf", "page-numbers", "edit-pdf", "protect-pdf"],
  "ocr-pdf": ["pdf-to-word", "chat-with-pdf", "compress-pdf", "edit-pdf"],
  "jpg-to-pdf": ["compress-pdf", "merge-pdf", "ocr-pdf", "edit-pdf"],
  "unlock-pdf": ["edit-pdf", "compress-pdf", "pdf-to-word", "merge-pdf"],
  "pdf-to-pptx": ["edit-pptx", "pptx-to-pdf"],
  // An encrypted result can't be opened by the other tools.
  "protect-pdf": [],
};

/** Chips only offer tools that take the result's file type. */
function nextSteps(slug: string, filename: string): string[] {
  const name = filename.toLowerCase();
  if (name.endsWith(".pdf")) {
    if (slug === "pdf-to-pptx") return [];
    return (NEXT_STEPS[slug] ?? NEXT_STEPS.default).filter((next) => next !== slug);
  }
  if (name.endsWith(".pptx")) return NEXT_STEPS["pdf-to-pptx"];
  return [];
}

type Status = "idle" | "working" | "done";

interface Entry {
  id: string;
  file: File;
}

let entrySeq = 0;

export function ToolWorkbench({ slug, tier = "guest" }: { slug: string; tier?: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const proc = PROCESSORS[slug];
  const inputRef = useRef<HTMLInputElement>(null);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [options, setOptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(proc.fields.map((f) => [f.key, f.default]))
  );
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ToolFile[]>([]);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [errorKey, setErrorKey] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));

  /** Where focus goes once the next state has rendered, so it never drops to the page. */
  const { next: focusNext, focusRef } = useFocusNext<"progress" | "done" | "run">();
  /** Holds the flow's height while the work view and the result swap. */
  const flow = useHeightLock<HTMLDivElement>();

  /** Shows a message; the same message again shakes again. */
  function fail(message: string | null) {
    setError(message);
    if (message) setErrorKey((k) => k + 1);
  }

  const files = entries.map((e) => e.file);
  const inputBytes = files.reduce((n, f) => n + f.size, 0);
  const outputBytes = results.reduce((n, r) => n + r.blob.size, 0);

  function addFiles(list: FileList | File[] | null) {
    if (!list?.length) return;
    const accepted = Array.from(list).filter((f) =>
      proc.accept.split(",").some((type) => {
        const t = type.trim();
        const name = f.name.toLowerCase();
        // Some browsers and OS share sheets leave `type` empty: fall back to the extension.
        return (
          f.type === t ||
          (t === "application/pdf" && name.endsWith(".pdf")) ||
          (!f.type && t === "image/jpeg" && /\.jpe?g$/.test(name)) ||
          (!f.type && t === "image/png" && name.endsWith(".png"))
        );
      })
    );
    if (!accepted.length) {
      fail(`That file type isn't supported here.`);
      return;
    }
    // Limits are an upgrade prompt, never a silent failure.
    if (accepted.some((f) => f.size > limits.maxFileBytes)) {
      setUpsell("file-size");
      fail(`Files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return;
    }
    const incoming = accepted.map((file) => ({ id: `f${++entrySeq}`, file }));
    // Decide from the current list, not inside the state updater: React may
    // run updaters later, so a flag set there is still false when read here.
    const next = proc.multiple ? [...entries, ...incoming] : incoming.slice(0, 1);
    if (next.length > limits.maxBatchFiles) setUpsell("batch");
    setEntries(next.slice(0, limits.maxBatchFiles));
    setStatus("idle");
    setResults([]);
    const skipped = list.length - accepted.length;
    fail(skipped ? `Skipped ${skipped} unsupported file${skipped === 1 ? "" : "s"}.` : null);
  }

  function setOption(key: string, value: string) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function visibleFields(): ToolField[] {
    return proc.fields.filter((f) => !f.showIf || options[f.showIf.key] === f.showIf.value);
  }

  async function run() {
    if (files.length < proc.minFiles) {
      fail(`Please add at least ${proc.minFiles} file${proc.minFiles > 1 ? "s" : ""}.`);
      return;
    }
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "progress";
    // Room for the result, reserved now while the click still explains it.
    flow.lock(resultFloor());
    setStatus("working");
    setError(null);
    setProgress(null);
    const started = performance.now();
    try {
      const out = await proc.run(files, options, {
        progress: (fraction, label) =>
          setProgress({ fraction: Math.max(0, Math.min(1, fraction)), label }),
      });
      const elapsedSeconds = (performance.now() - started) / 1000;
      // Let the bar visibly finish before the result replaces it.
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      setResults(Array.isArray(out) ? out : [out]);
      setElapsed(elapsedSeconds);
      if (focusNext.current || document.activeElement?.closest("[data-progress]")) focusNext.current = "done";
      setStatus("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch (err) {
      fail(friendlyPdfError(err).message);
      if (focusNext.current || document.activeElement?.closest("[data-progress]")) focusNext.current = "run";
      setStatus("idle");
    } finally {
      setProgress(null);
    }
  }

  async function downloadAll() {
    nudge.downloaded();
    if (results.length === 1) {
      downloadBlob(results[0].blob, results[0].filename);
      return;
    }
    if (proc.zipName) {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      for (const r of results) zip.file(r.filename, r.blob);
      downloadBlob(await zip.generateAsync({ type: "blob" }), proc.zipName);
    } else {
      results.forEach((r) => downloadBlob(r.blob, r.filename));
    }
  }

  /** Hands the result to another tool without a download/re-upload round trip. */
  async function continueWith(nextSlug: string) {
    const r = results[0];
    await setHandoff([await fileToHandoff(r.blob, r.filename)]);
    router.push(`/tools/${nextSlug}?handoff=1`);
  }

  // Files handed over from the homepage dropzone or a previous tool.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => handed.length && addFiles(handed.map(handoffToFile)))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    nudge.cancel();
    flow.lock();
    setEntries([]);
    setResults([]);
    setStatus("idle");
    setError(null);
  }

  const sizeDelta =
    proc.reportsSizeChange && results.length === 1 && inputBytes > 0
      ? 1 - outputBytes / inputBytes
      : null;

  return (
    <>
    <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
    <AnimatePresence mode="wait" initial={false}>
      {status === "done" ? (
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
                {results.length} file{results.length === 1 ? "" : "s"} ·{" "}
                {sizeDelta !== null && sizeDelta > 0.01 ? (
                  <CountUp from={inputBytes} to={outputBytes} format={formatBytes} duration={SUCCESS.count} delay={SUCCESS.stats} />
                ) : (
                  formatBytes(outputBytes)
                )}
              </span>
              {sizeDelta !== null && sizeDelta > 0.01 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-700">
                  <TrendingDown className="h-3 w-3" />
                  <CountUp to={Math.round(sizeDelta * 100)} suffix="% smaller" duration={SUCCESS.count} delay={SUCCESS.stats} />
                </span>
              )}
              {sizeDelta !== null && sizeDelta <= 0.01 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 font-medium text-sky-800">
                  Already optimized
                </span>
              )}
            </>
          }
          files={results.map((r) => ({
            name: r.filename,
            size: r.blob.size,
            onDownload: () => {
              nudge.downloaded();
              downloadBlob(r.blob, r.filename);
            },
          }))}
          actions={
            <>
              <Button onClick={downloadAll} size="lg" className="min-w-44 shadow-lg shadow-primary/25">
                <Download />
                {results.length > 1 && proc.zipName ? "Download all (.zip)" : "Download"}
              </Button>
              <Button onClick={reset} variant="outline" size="lg">
                <RotateCcw /> Start over
              </Button>
            </>
          }
          next={
            results.length === 1
              ? { slugs: nextSteps(slug, results[0].filename), onPick: (next) => void continueWith(next) }
              : undefined
          }
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
          onAnimationComplete={(def) => def !== EXIT && flow.release()}
          className="space-y-5"
        >
          <ToolDropzone label={`Drop ${proc.multiple ? "files" : "a file"} here`} onFiles={addFiles}>
            <input
              ref={inputRef}
              type="file"
              accept={proc.accept}
              multiple={proc.multiple}
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <p className="text-sm text-muted-foreground">or</p>
            <Button className="mt-3 h-11" onClick={() => inputRef.current?.click()}>
              Choose {proc.multiple ? "files" : "file"}
            </Button>
            <p className="mt-4 text-xs text-muted-foreground">Stays on your device.</p>
          </ToolDropzone>

          {/* File list (drag to reorder when multiple) */}
          {entries.length > 0 && (
            <Reorder.Group
              axis="y"
              values={entries}
              onReorder={setEntries}
              className="space-y-2"
            >
              <AnimatePresence initial={false}>
                {entries.map((entry) => (
                  <FileRow
                    key={entry.id}
                    entry={entry}
                    movable={proc.multiple}
                    onMove={(delta) =>
                      setEntries((prev) => {
                        const from = prev.findIndex((x) => x.id === entry.id);
                        const to = from + delta;
                        if (from < 0 || to < 0 || to >= prev.length) return prev;
                        const next = [...prev];
                        [next[from], next[to]] = [next[to], next[from]];
                        return next;
                      })
                    }
                    onRemove={() => setEntries((prev) => prev.filter((e) => e.id !== entry.id))}
                  />
                ))}
              </AnimatePresence>
            </Reorder.Group>
          )}

          {/* Options */}
          <AnimatePresence>
            {entries.length > 0 && visibleFields().length > 0 && (
              <motion.div
                initial={ENTER.initial}
                animate={ENTER.animate}
                exit={EXIT}
                className="grid gap-4 rounded-2xl border border-border bg-card p-5 sm:grid-cols-2"
              >
                {visibleFields().map((field) => (
                  <div key={field.key}>
                    <label htmlFor={`opt-${field.key}`} className="mb-1.5 block text-sm font-medium">
                      {field.label}
                    </label>
                    {field.type === "select" && (
                      <select
                        id={`opt-${field.key}`}
                        value={options[field.key]}
                        onChange={(e) => setOption(field.key, e.target.value)}
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base sm:text-sm"
                      >
                        {field.options!.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {field.type === "text" && (
                      <Input
                        id={`opt-${field.key}`}
                        value={options[field.key]}
                        onChange={(e) => setOption(field.key, e.target.value)}
                      />
                    )}
                    {field.type === "password" && (
                      <div className="relative">
                        <Input
                          id={`opt-${field.key}`}
                          type={revealed[field.key] ? "text" : "password"}
                          autoComplete="new-password"
                          value={options[field.key]}
                          onChange={(e) => setOption(field.key, e.target.value)}
                          className="pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setRevealed((r) => ({ ...r, [field.key]: !r[field.key] }))}
                          className="absolute right-0 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
                          aria-label={revealed[field.key] ? "Hide password" : "Show password"}
                        >
                          {revealed[field.key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                    )}
                    {field.type === "color" && (
                      <input
                        id={`opt-${field.key}`}
                        type="color"
                        value={options[field.key]}
                        onChange={(e) => setOption(field.key, e.target.value)}
                        className="h-10 w-full cursor-pointer rounded-lg border border-input bg-background px-1"
                      />
                    )}
                    {field.type === "range" && (
                      <div className="flex items-center gap-3">
                        <input
                          id={`opt-${field.key}`}
                          type="range"
                          min={field.min}
                          max={field.max}
                          step={field.step}
                          value={options[field.key]}
                          onChange={(e) => setOption(field.key, e.target.value)}
                          className="h-6 flex-1 accent-[hsl(var(--primary))]"
                        />
                        <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
                          {Math.round(Number(options[field.key]) * 100)}%
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {error && <InlineError key="error" message={error} shakeKey={errorKey} />}
          </AnimatePresence>

          {/* Action: the Cast button gives way to the progress bar in place. */}
          <AnimatePresence>
            {entries.length > 0 && (
              <motion.div
                initial={ENTER.initial}
                animate={ENTER.animate}
                exit={FADE_EXIT}
                className="relative flex flex-col items-center gap-3"
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  {status === "working" ? (
                    <motion.div
                      key="progress"
                      ref={focusRef("progress")}
                      tabIndex={-1}
                      data-progress
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0, transition: NOTICE_T }}
                      exit={FADE_EXIT}
                      className="w-full max-w-md outline-none"
                    >
                      <ProgressBar value={progress?.fraction} label="Progress" />
                      <p aria-hidden className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                        <WorkingGlyph />
                        {progress?.label ?? "Casting…"}
                        {progress && (
                          <span className="tabular-nums">{Math.round(progress.fraction * 100)}%</span>
                        )}
                      </p>
                      {/* Announces the stage, not every percent. */}
                      <p className="sr-only" aria-live="polite">
                        {progress?.label ?? "Casting…"}
                      </p>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="cast"
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1, transition: NOTICE_T }}
                      exit={{ opacity: 0, scale: 0.97, transition: { duration: DUR.tap, ease: EXIT_T.ease } }}
                    >
                      <Button ref={focusRef("run")} size="lg" onClick={run} data-cast className="min-w-52 shadow-lg shadow-primary/25">
                        <Sparkles /> Cast spell
                      </Button>
                    </motion.div>
                  )}
                </AnimatePresence>
                {proc.note && (
                  <p className="max-w-md text-center text-xs text-muted-foreground">{proc.note}</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
    </div>
    {upsell && (
      <UpgradeDialog
        open
        onOpenChange={(open) => !open && setUpsell(null)}
        reason={upsell}
        tier={tier}
        returnTo={`/tools/${slug}`}
      />
    )}
    </>
  );
}

/**
 * One chosen file. Only the grip starts a drag, so a swipe on the row
 * scrolls the page instead of reordering the list.
 */
function FileRow({
  entry,
  movable,
  onMove,
  onRemove,
}: {
  entry: Entry;
  movable: boolean;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={entry}
      dragListener={false}
      dragControls={controls}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: EXIT_T }}
      transition={{ ...ENTER_T, layout: SPRING_LAYOUT }}
      whileDrag={{ scale: 1.02, boxShadow: "0 12px 30px -10px rgba(0,0,0,0.25)" }}
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      {movable && (
        // Drag handle that also reorders from the keyboard (↑/↓).
        <button
          type="button"
          aria-label={`Move ${entry.file.name} (up/down arrows)`}
          onPointerDown={(e) => controls.start(e)}
          onKeyDown={(e) => {
            const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
            if (!delta) return;
            e.preventDefault();
            const btn = e.currentTarget;
            onMove(delta);
            requestAnimationFrame(() => btn.focus());
          }}
          className="-my-1.5 -ml-3 flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <FileIcon className="h-5 w-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{entry.file.name}</p>
        <p className="text-xs text-muted-foreground">{formatBytes(entry.file.size)}</p>
      </div>
      <button
        onClick={onRemove}
        className="-my-1.5 -mr-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`Remove ${entry.file.name}`}
      >
        <X className="h-4 w-4" />
      </button>
    </Reorder.Item>
  );
}
