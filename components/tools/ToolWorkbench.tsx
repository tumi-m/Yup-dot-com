"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, Reorder, useDragControls, useReducedMotion } from "motion/react";
import {
  File as FileIcon,
  X,
  Download,
  Loader2,
  Sparkles,
  GripVertical,
  Eye,
  EyeOff,
  RotateCcw,
  Timer,
  TrendingDown,
  Info,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToolDropzone } from "@/components/ui/dropzone";
import { downloadBlob } from "@/lib/download";
import { cn, formatBytes } from "@/lib/utils";
import type { ToolFile } from "@/lib/pdf/toolkit";
import {
  CountUp,
  ENTER,
  ENTER_T,
  EXIT,
  EXIT_T,
  FADE_EXIT,
  HANDOFF,
  InlineError,
  NOTICE_T,
  PROGRESS_HOLD_MS,
  SPRING_LAYOUT,
  SUCCESS,
} from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import {
  resultFloor,
  scrollBehavior,
  SETTLE_TOP,
  settleSlot,
  useFocusNext,
  useHeightLock,
} from "@/components/motion/focus";
import { PROCESSORS, type ToolField } from "./processors";
import { focusAfterRemove, movedMessage } from "@/components/list-focus";
import { SuccessCard } from "./SuccessCard";
import { percentSmaller, sortPick, takesFile } from "./file-pick";
import { limitsFor, formatLimitBytes, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { recordTask, upsellCardDismissed, dismissUpsellCard } from "@/lib/nudge";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { friendlyPdfError } from "@/lib/pdf/errors";
import { trackToolUsed } from "@/lib/analytics";
import { getTool } from "@/lib/tools";

/** Resize PDF's preview loads with that tool only. */
const ResizePreview = lazy(() => import("./ResizePreview").then((m) => ({ default: m.ResizePreview })));

/** Where a finished PDF can go next — Smallpdf-style "keep going" chaining. */
const NEXT_STEPS: Record<string, string[]> = {
  default: ["compress-pdf", "edit-pdf", "sign-pdf", "protect-pdf"],
  "compress-pdf": ["edit-pdf", "protect-pdf", "sign-pdf", "pdf-to-word"],
  "merge-pdf": ["compress-pdf", "page-numbers", "edit-pdf", "protect-pdf"],
  "ocr-pdf": ["pdf-to-word", "chat-with-pdf", "compress-pdf", "edit-pdf"],
  "jpg-to-pdf": ["compress-pdf", "merge-pdf", "ocr-pdf", "edit-pdf"],
  "png-to-pdf": ["compress-pdf", "merge-pdf", "ocr-pdf", "edit-pdf"],
  "webp-to-pdf": ["compress-pdf", "merge-pdf", "ocr-pdf", "edit-pdf"],
  "heic-to-pdf": ["compress-pdf", "merge-pdf", "ocr-pdf", "edit-pdf"],
  "tiff-to-pdf": ["ocr-pdf", "compress-pdf", "merge-pdf", "edit-pdf"],
  "svg-to-pdf": ["merge-pdf", "compress-pdf", "edit-pdf", "protect-pdf"],
  // Real text already: no OCR.
  "txt-to-pdf": ["merge-pdf", "protect-pdf", "sign-pdf", "edit-pdf"],
  "markdown-to-pdf": ["merge-pdf", "protect-pdf", "sign-pdf", "edit-pdf"],
  "unlock-pdf": ["edit-pdf", "compress-pdf", "pdf-to-word", "merge-pdf"],
  "resize-pdf": ["compress-pdf", "page-numbers", "merge-pdf", "protect-pdf"],
  "pdf-to-pptx": ["edit-pptx", "pptx-to-pdf"],
  "flatten-pdf": ["protect-pdf", "compress-pdf", "merge-pdf", "watermark-pdf"],
  // Pages that came back as pictures can be read again with OCR.
  "repair-pdf": ["compress-pdf", "ocr-pdf", "edit-pdf", "merge-pdf"],
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

/** The sentence under a field: its own, or the picked option's. */
function fieldHint(field: ToolField, value: string): string | undefined {
  return field.options?.find((o) => o.value === value)?.hint ?? field.hint;
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
  /** The result has been downloaded at least once, so leaving doesn't lose it. */
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [errorKey, setErrorKey] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  /** The next tool the result couldn't be passed to. */
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  /** Read out when a file is moved with the arrow keys. */
  const [moveNote, setMoveNote] = useState("");
  /** The zip for "Download all" is being built. */
  const [zipping, setZipping] = useState(false);
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));

  /** Where focus goes once the next state has rendered, so it never drops to the page. */
  const { next: focusNext, focusRef } = useFocusNext<"progress" | "done" | "run" | "choose">();
  /** Holds the flow's height while the work view and the result swap. */
  const flow = useHeightLock<HTMLDivElement>();
  /** The running job; aborted on Cancel, on new files and when the page goes away. */
  const job = useRef<AbortController | null>(null);
  useEffect(() => () => job.current?.abort(), []);
  /** Files were just added: scroll them into view once they render. */
  const bringUp = useRef(false);

  /** Shows a message; the same message again shakes again. */
  function fail(message: string | null) {
    setError(message);
    if (message) setErrorKey((k) => k + 1);
  }

  const files = entries.map((e) => e.file);
  const inputBytes = files.reduce((n, f) => n + f.size, 0);
  const outputBytes = results.reduce((n, r) => n + r.blob.size, 0);

  /** Adds the files that fit; false when none could be added. */
  function addFiles(list: FileList | File[] | null): boolean {
    if (!list?.length) return false;
    const takes = proc.alsoAccepts ? `${proc.accept},${proc.alsoAccepts}` : proc.accept;
    const accepted = Array.from(list).filter((f) => takesFile(takes, f));
    if (!accepted.length) {
      fail(`That file type isn't supported here.`);
      return false;
    }
    // Limits are an upgrade prompt, never a silent failure.
    const { keep, tooBig, message } = sortPick(accepted, list.length - accepted.length, {
      maxFileBytes: limits.maxFileBytes,
      multiple: proc.multiple,
      toolName: getTool(slug)?.name,
    });
    if (tooBig) setUpsell("file-size");
    if (!keep.length) {
      fail(message);
      return false;
    }
    stopJob();
    const incoming = keep.map((file) => ({ id: `f${++entrySeq}`, file }));
    // Decide from the current list, not inside the state updater: React may
    // run updaters later, so a flag set there is still false when read here.
    const next = proc.multiple ? [...entries, ...incoming] : incoming.slice(0, 1);
    if (next.length > limits.maxBatchFiles) setUpsell("batch");
    setEntries(next.slice(0, limits.maxBatchFiles));
    setStatus("idle");
    setResults([]);
    fail(message);
    bringUp.current = true;
    return true;
  }

  // On a phone (or after a handoff) new files and Cast spell can land below
  // the fold: once they have rendered, bring the list up under the header.
  useEffect(() => {
    if (!bringUp.current) return;
    bringUp.current = false;
    requestAnimationFrame(() => {
      const root = flow.ref.current;
      const cast = root?.querySelector<HTMLElement>("[data-cast]");
      const list = root?.querySelector<HTMLElement>("[data-files]");
      if (!cast || !list || cast.getBoundingClientRect().bottom <= window.innerHeight) return;
      window.scrollTo({ top: window.scrollY + list.getBoundingClientRect().top - SETTLE_TOP, behavior: scrollBehavior() });
    });
  }, [entries, flow.ref]);

  /** Changing the list stops a running job, so no result shows for files that are gone. */
  function editList() {
    if (job.current) stopJob();
  }

  /** Moves a file up or down the list from the keyboard, and says where it went. */
  function moveEntry(id: string, delta: number) {
    const from = entries.findIndex((x) => x.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= entries.length) return;
    editList();
    const next = [...entries];
    [next[from], next[to]] = [next[to], next[from]];
    setEntries(next);
    setMoveNote(movedMessage(entries[from].file.name, to, next.length));
  }

  function removeEntry(id: string) {
    editList();
    // The row leaves with the focused button: hand focus to the next row's
    // Remove (or the one before), or back to Choose when no file is left.
    if (document.activeElement?.closest("[data-remove]")) {
      const target = focusAfterRemove(entries.map((e) => e.id), id);
      if (target) {
        requestAnimationFrame(() =>
          flow.ref.current?.querySelector<HTMLElement>(`[data-remove="${target}"]`)?.focus()
        );
      } else {
        focusNext.current = "choose";
      }
    }
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function setOption(key: string, value: string) {
    setOptions((prev) => ({ ...prev, [key]: value }));
    // A message about the old options would stay after they were fixed.
    setError(null);
  }

  /** What is wrong with the options, shown under their fields as they change. */
  const problem = proc.problem?.(options) ?? null;

  function visibleFields(): ToolField[] {
    return proc.fields.filter((f) => !f.showIf || options[f.showIf.key] === f.showIf.value);
  }

  async function run() {
    if (files.length < proc.minFiles) {
      fail(`Please add at least ${proc.minFiles} file${proc.minFiles > 1 ? "s" : ""}.`);
      return;
    }
    if (problem) {
      // Said under the field already: take the person there.
      flow.ref.current?.querySelector<HTMLElement>(`#opt-${problem.fields[0]}`)?.focus();
      return;
    }
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "progress";
    // Room for the result, reserved now while the click still explains it.
    flow.lock(resultFloor());
    setStatus("working");
    setError(null);
    setProgress(null);
    setNextFailed(null);
    const started = performance.now();
    const ctl = new AbortController();
    job.current = ctl;
    try {
      const out = await proc.run(files, options, {
        progress: (fraction, label) => {
          if (!ctl.signal.aborted) setProgress({ fraction: Math.max(0, Math.min(1, fraction)), label });
        },
        signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      const elapsedSeconds = (performance.now() - started) / 1000;
      // Let the bar visibly finish before the result replaces it.
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      setResults(Array.isArray(out) ? out : [out]);
      setDownloaded(false);
      setElapsed(elapsedSeconds);
      if (focusNext.current || document.activeElement?.closest("[data-progress]")) focusNext.current = "done";
      settleSlot(flow.ref.current);
      setStatus("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch (err) {
      if (ctl.signal.aborted) return;
      fail(friendlyPdfError(err).message);
      if (focusNext.current || document.activeElement?.closest("[data-progress]")) focusNext.current = "run";
      // The work view stays, so nothing else lets go of the room kept for the result.
      flow.release();
      setStatus("idle");
    } finally {
      if (job.current === ctl) {
        job.current = null;
        setProgress(null);
      }
    }
  }

  /** Stops the running job, if any, and goes back to the ready state. */
  function stopJob() {
    if (!job.current) return;
    job.current.abort();
    job.current = null;
    setProgress(null);
    flow.release();
    setStatus("idle");
  }

  function cancel() {
    focusNext.current = "run";
    stopJob();
  }

  async function downloadAll() {
    nudge.downloaded();
    setDownloaded(true);
    if (results.length === 1) {
      downloadBlob(results[0].blob, results[0].filename);
      return;
    }
    if (proc.zipName) {
      // A second click while the zip builds would save it twice.
      if (zipping) return;
      setZipping(true);
      try {
        const JSZip = (await import("jszip")).default;
        const { zipEntryOptionsFor } = await import("@/lib/zip");
        const zip = new JSZip();
        for (const r of results) zip.file(r.filename, r.blob, await zipEntryOptionsFor(r.filename, r.blob));
        // Named after the input, so two splits don't both save as the same name.
        const base = files[0]?.name.replace(/\.pdf$/i, "");
        downloadBlob(await zip.generateAsync({ type: "blob" }), base ? `${base}-${proc.zipName}` : proc.zipName);
      } finally {
        setZipping(false);
      }
    } else {
      results.forEach((r) => downloadBlob(r.blob, r.filename));
    }
  }

  /** Hands the result to another tool without a download/re-upload round trip. */
  async function continueWith(nextSlug: string) {
    nudge.cancel();
    setNextFailed(null);
    const r = results[0];
    if (await tryHandoff([fileToHandoff(r.blob, r.filename)])) router.push(`/tools/${nextSlug}?handoff=1`);
    else setNextFailed(nextSlug);
  }

  // Files handed over from the homepage dropzone or a previous tool.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        if (!handed.length) return;
        // The visitor chose this file a page ago: Cast spell is the next step.
        // Set after adding, so a handoff that is turned away leaves no focus
        // waiting for the next pick.
        if (addFiles(handed.map(handoffToFile))) focusNext.current = "run";
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function reset() {
    stopJob();
    nudge.cancel();
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "choose";
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
                  <CountUp to={percentSmaller(sizeDelta)} suffix="% smaller" duration={SUCCESS.count} delay={SUCCESS.stats} />
                </span>
              )}
              {sizeDelta !== null && sizeDelta < -0.01 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 font-medium text-amber-800">
                  {Math.round(-sizeDelta * 100)}% larger
                </span>
              )}
              {sizeDelta !== null && Math.abs(sizeDelta) <= 0.01 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 font-medium text-sky-800">
                  Already optimized
                </span>
              )}
              {results.length === 1 && results[0].report && (
                <ul className="w-full max-w-md space-y-1.5 text-left" aria-label="What was done">
                  {results[0].report.map((line) => (
                    <li
                      key={line.text}
                      className={cn(
                        "flex items-start gap-1.5 rounded-lg px-2.5 py-1.5",
                        line.warn ? "bg-amber-100 font-medium text-amber-800" : "bg-secondary text-muted-foreground"
                      )}
                    >
                      {line.warn ? <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> : <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
                      {line.text}
                    </li>
                  ))}
                </ul>
              )}
              {results.length === 1 && results[0].note && (
                <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-left font-medium text-amber-800">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" /> {results[0].note}
                </span>
              )}
            </>
          }
          files={results.map((r) => ({
            name: r.filename,
            size: r.blob.size,
            onDownload: () => {
              nudge.downloaded();
              setDownloaded(true);
              downloadBlob(r.blob, r.filename);
            },
          }))}
          actions={
            <>
              <Button
                onClick={downloadAll}
                size="lg"
                disabled={zipping}
                aria-busy={zipping || undefined}
                className="min-w-44 shadow-lg shadow-primary/25"
              >
                {zipping ? <Loader2 className="motion-safe:animate-spin" /> : <Download />}
                {results.length > 1 && proc.zipName ? "Download all (.zip)" : "Download"}
              </Button>
              <Button onClick={reset} variant="outline" size="lg">
                <RotateCcw /> Start over
              </Button>
            </>
          }
          next={
            results.length === 1
              ? { slugs: nextSteps(slug, results[0].filename), onPick: (next) => void continueWith(next), failed: nextFailed }
              : undefined
          }
          upsell={
            showCard && (
              <UpsellCard
                tier={tier}
                returnTo={`/tools/${slug}`}
                unsaved={!downloaded}
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
            <Button ref={focusRef("choose")} className="mt-3 h-11" onClick={() => inputRef.current?.click()}>
              Choose {proc.multiple ? "files" : "file"}
            </Button>
            <p className="mt-4 text-xs text-muted-foreground">
              Up to {formatLimitBytes(limits.maxFileBytes)} · Stays on your device.
            </p>
          </ToolDropzone>

          {/* File list (drag to reorder when multiple) */}
          {entries.length > 0 && (
            <Reorder.Group
              axis="y"
              values={entries}
              onReorder={(next) => {
                editList();
                setEntries(next);
              }}
              data-files
              className="space-y-2"
            >
              <AnimatePresence initial={false}>
                {entries.map((entry, i) => (
                  <FileRow
                    key={entry.id}
                    entry={entry}
                    position={i + 1}
                    count={entries.length}
                    movable={proc.multiple}
                    onMove={(delta) => moveEntry(entry.id, delta)}
                    onRemove={() => removeEntry(entry.id)}
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
                {visibleFields().map((field) => {
                  const hint = fieldHint(field, options[field.key]);
                  const invalid = !!problem?.fields.includes(field.key);
                  const hintId = [hint && `opt-${field.key}-hint`, invalid && "opt-problem"].filter(Boolean).join(" ") || undefined;
                  return (
                  <div key={field.key} className={field.wide ? "sm:col-span-2" : undefined}>
                    {field.type === "checkbox" ? (
                      // The box sits level with the selects beside it.
                      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium sm:mt-7 sm:min-h-10">
                        <input
                          id={`opt-${field.key}`}
                          type="checkbox"
                          checked={options[field.key] === "true"}
                          onChange={(e) => setOption(field.key, e.target.checked ? "true" : "")}
                          aria-describedby={hintId}
                          className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                        />
                        {field.label}
                      </label>
                    ) : (
                      <label htmlFor={`opt-${field.key}`} className="mb-1.5 block text-sm font-medium">
                        {field.label}
                      </label>
                    )}
                    {field.type === "select" && (
                      <select
                        id={`opt-${field.key}`}
                        value={options[field.key]}
                        onChange={(e) => setOption(field.key, e.target.value)}
                        aria-describedby={hintId}
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base pointer-coarse:h-11 sm:text-sm"
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
                        inputMode={field.inputMode}
                        value={options[field.key]}
                        onChange={(e) => setOption(field.key, e.target.value)}
                        aria-invalid={invalid || undefined}
                        aria-describedby={hintId}
                        className={cn("pointer-coarse:h-11", invalid && "border-destructive")}
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
                          className="pr-10 pointer-coarse:h-11 pointer-coarse:pr-11"
                        />
                        <button
                          type="button"
                          onClick={() => setRevealed((r) => ({ ...r, [field.key]: !r[field.key] }))}
                          className="absolute right-0 top-1/2 flex h-10 w-10 -translate-y-1/2 pointer-coarse:h-11 pointer-coarse:w-11 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
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
                        className="h-10 w-full cursor-pointer rounded-lg border border-input bg-background px-1 pointer-coarse:h-11"
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
                    {hint && (
                      <p id={`opt-${field.key}-hint`} className={`mt-1.5 text-xs text-muted-foreground ${field.type === "checkbox" ? "pl-[30px]" : ""}`}>
                        {hint}
                      </p>
                    )}
                    {/* Once, under the last field it is about. */}
                    {invalid && problem!.fields.at(-1) === field.key && (
                      <p id="opt-problem" className="mt-1.5 text-xs text-destructive">
                        {problem!.message}
                      </p>
                    )}
                  </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          {proc.preview === "resize" && entries.length > 0 && (
            <Suspense fallback={null}>
              <ResizePreview file={entries[0].file} options={options} />
            </Suspense>
          )}

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
                      initial={HANDOFF.in.initial}
                      animate={HANDOFF.in.animate}
                      exit={FADE_EXIT}
                      className="w-full max-w-md rounded-xl outline-none ring-offset-4 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <motion.div initial={HANDOFF.track.initial} animate={HANDOFF.track.animate}>
                        <ProgressBar value={progress?.fraction} label="Progress" />
                      </motion.div>
                      <p aria-hidden className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                        <WorkingGlyph />
                        {/* The number hangs off the label, so the label stays put as it grows. */}
                        <span className="relative">
                          {progress?.label ?? "Casting…"}
                          <span className="absolute left-full top-0 ml-1.5">
                            <ProgressPercent value={progress?.fraction} />
                          </span>
                        </span>
                      </p>
                      {/* Announces the stage, not every percent. */}
                      <p className="sr-only" aria-live="polite">
                        {progress?.label ?? "Casting…"}
                      </p>
                      {proc.cancellable && (
                        <div className="mt-2 flex justify-center">
                          <Button variant="ghost" className="h-11 text-muted-foreground" onClick={cancel}>
                            <X /> Cancel
                          </Button>
                        </div>
                      )}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="cast"
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1, transition: NOTICE_T }}
                      exit={HANDOFF.out}
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
    <p className="sr-only" aria-live="polite">
      {moveNote}
    </p>
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
  position,
  count,
  movable,
  onMove,
  onRemove,
}: {
  entry: Entry;
  /** 1-based place in the list, which sets the merge order. */
  position: number;
  count: number;
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
          aria-label={`Move ${entry.file.name}, ${position} of ${count} (up/down arrows)`}
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
        data-remove={entry.id}
        onClick={onRemove}
        className="-my-1.5 -mr-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={`Remove ${entry.file.name}`}
      >
        <X className="h-4 w-4" />
      </button>
    </Reorder.Item>
  );
}
