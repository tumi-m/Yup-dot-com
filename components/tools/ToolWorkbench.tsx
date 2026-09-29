"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import JSZip from "jszip";
import { AnimatePresence, motion, Reorder } from "motion/react";
import {
  UploadCloud,
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
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadBlob } from "@/lib/download";
import { formatBytes, cn } from "@/lib/utils";
import type { ToolFile } from "@/lib/pdf/toolkit";
import { EASE, SPRING, SparkleBurst } from "@/components/motion/primitives";
import { PROCESSORS, type ToolField } from "./processors";
import { limitsFor, formatLimitBytes, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, setHandoff, takeHandoff } from "@/lib/local-store";
import { recordTask, upsellCardDismissed, dismissUpsellCard } from "@/lib/nudge";
import { UpgradeDialog, UpsellCard, type UpsellReason } from "@/components/upsell/Upsell";
import { getTool } from "@/lib/tools";

/** Where a finished PDF can go next — Smallpdf-style "keep going" chaining. */
const NEXT_STEPS: Record<string, string[]> = {
  default: ["compress-pdf", "edit-pdf", "sign-pdf", "protect-pdf"],
  "compress-pdf": ["edit-pdf", "protect-pdf", "sign-pdf", "pdf-to-word"],
  "merge-pdf": ["compress-pdf", "page-numbers", "edit-pdf", "protect-pdf"],
  "ocr-pdf": ["pdf-to-word", "chat-with-pdf", "compress-pdf", "edit-pdf"],
  "jpg-to-pdf": ["compress-pdf", "merge-pdf", "ocr-pdf", "edit-pdf"],
  "unlock-pdf": ["edit-pdf", "compress-pdf", "pdf-to-word", "merge-pdf"],
  "pdf-to-pptx": ["edit-pptx", "pptx-to-pdf", "compress-pdf", "pdf-to-word"],
};

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
  const [dragging, setDragging] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const files = entries.map((e) => e.file);
  const inputBytes = files.reduce((n, f) => n + f.size, 0);
  const outputBytes = results.reduce((n, r) => n + r.blob.size, 0);

  function addFiles(list: FileList | File[] | null) {
    if (!list?.length) return;
    const accepted = Array.from(list).filter((f) =>
      proc.accept.split(",").some((type) => {
        const t = type.trim();
        return f.type === t || (t === "application/pdf" && f.name.toLowerCase().endsWith(".pdf"));
      })
    );
    if (!accepted.length) {
      setError(`That file type isn't supported here.`);
      return;
    }
    // Limits are an upgrade prompt, never a silent failure.
    if (accepted.some((f) => f.size > limits.maxFileBytes)) {
      setUpsell("file-size");
      setError(`Files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return;
    }
    const incoming = accepted.map((file) => ({ id: `f${++entrySeq}`, file }));
    let over = false;
    setEntries((prev) => {
      const next = proc.multiple ? [...prev, ...incoming] : incoming.slice(0, 1);
      if (next.length > limits.maxBatchFiles) {
        over = true;
        return next.slice(0, limits.maxBatchFiles);
      }
      return next;
    });
    if (over) setUpsell("batch");
    setStatus("idle");
    setResults([]);
    setError(null);
  }

  function setOption(key: string, value: string) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function visibleFields(): ToolField[] {
    return proc.fields.filter((f) => !f.showIf || options[f.showIf.key] === f.showIf.value);
  }

  async function run() {
    if (files.length < proc.minFiles) {
      setError(`Please add at least ${proc.minFiles} file${proc.minFiles > 1 ? "s" : ""}.`);
      return;
    }
    setStatus("working");
    setError(null);
    setProgress(null);
    const started = performance.now();
    try {
      const out = await proc.run(files, options, {
        progress: (fraction, label) =>
          setProgress({ fraction: Math.max(0, Math.min(1, fraction)), label }),
      });
      setResults(Array.isArray(out) ? out : [out]);
      setElapsed((performance.now() - started) / 1000);
      setStatus("done");
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) setTimeout(() => setUpsell("nudge"), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("idle");
    } finally {
      setProgress(null);
    }
  }

  async function downloadAll() {
    if (results.length === 1) {
      downloadBlob(results[0].blob, results[0].filename);
      return;
    }
    if (proc.zipName) {
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
    <AnimatePresence mode="wait" initial={false}>
      {status === "done" ? (
        <motion.div
          key="done"
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="relative overflow-hidden rounded-3xl border border-border bg-card p-10 text-center shadow-xl shadow-primary/5"
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
              {results.length} file{results.length === 1 ? "" : "s"} · {formatBytes(outputBytes)}
            </span>
            {sizeDelta !== null && sizeDelta > 0.01 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-700">
                <TrendingDown className="h-3 w-3" /> {Math.round(sizeDelta * 100)}% smaller
              </span>
            )}
            {sizeDelta !== null && sizeDelta <= 0.01 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-1 font-medium text-sky-800">
                Already optimized
              </span>
            )}
          </motion.div>

          {results.length > 1 && (
            <ul className="relative mx-auto mt-6 max-h-56 max-w-md space-y-1.5 overflow-y-auto text-left">
              {results.map((r, i) => (
                <motion.li
                  key={r.filename + i}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 + Math.min(i, 10) * 0.04 }}
                  className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                >
                  <FileIcon className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{r.filename}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(r.blob.size)}</span>
                  <button
                    onClick={() => downloadBlob(r.blob, r.filename)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={`Download ${r.filename}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                </motion.li>
              ))}
            </ul>
          )}

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.5, ease: EASE }}
            className="relative mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Button onClick={downloadAll} size="lg" className="min-w-44 shadow-lg shadow-primary/25">
              <Download />
              {results.length > 1 && proc.zipName ? "Download all (.zip)" : "Download"}
            </Button>
            <Button onClick={reset} variant="outline" size="lg">
              <RotateCcw /> Start over
            </Button>
          </motion.div>

          {results.length === 1 && results[0].filename.toLowerCase().endsWith(".pdf") && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.5, ease: EASE }}
              className="relative mt-8"
            >
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Next
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {(NEXT_STEPS[slug] ?? NEXT_STEPS.default).map((next) => {
                  const t = getTool(next);
                  if (!t) return null;
                  return (
                    <motion.button
                      key={next}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => continueWith(next)}
                      className="flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm font-medium transition-colors hover:border-primary/50"
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
          )}

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
          {/* Dropzone */}
          <motion.div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
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
            <motion.div
              animate={dragging ? { y: -6, scale: 1.1 } : { y: [0, -5, 0] }}
              transition={
                dragging ? SPRING : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }
              }
              className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"
            >
              <UploadCloud className="h-7 w-7" />
            </motion.div>
            <p className="relative mt-4 text-lg font-semibold">
              {dragging ? "Release to add" : `Drop ${proc.multiple ? "files" : "a file"} here`}
            </p>
            <p className="relative text-sm text-muted-foreground">or</p>
            <Button className="relative mt-3 h-11" onClick={() => inputRef.current?.click()}>
              Choose {proc.multiple ? "files" : "file"}
            </Button>
            <p className="relative mt-4 text-xs text-muted-foreground">
              Stays on your device.
            </p>
          </motion.div>

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
                  <Reorder.Item
                    key={entry.id}
                    value={entry}
                    dragListener={proc.multiple}
                    initial={{ opacity: 0, height: 0, y: -6 }}
                    animate={{ opacity: 1, height: "auto", y: 0 }}
                    exit={{ opacity: 0, height: 0, x: 30 }}
                    transition={{ duration: 0.3, ease: EASE }}
                    whileDrag={{ scale: 1.02, boxShadow: "0 12px 30px -10px rgba(0,0,0,0.25)" }}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
                  >
                    {proc.multiple && (
                      <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" />
                    )}
                    <FileIcon className="h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{entry.file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(entry.file.size)}</p>
                    </div>
                    <button
                      onClick={() => setEntries((prev) => prev.filter((e) => e.id !== entry.id))}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      aria-label={`Remove ${entry.file.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Reorder.Item>
                ))}
              </AnimatePresence>
            </Reorder.Group>
          )}

          {/* Options */}
          <AnimatePresence>
            {entries.length > 0 && visibleFields().length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.35, ease: EASE }}
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
                        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
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
                          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
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
                          className="flex-1 accent-[hsl(var(--primary))]"
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
            {error && (
              <motion.p
                role="alert"
                data-testid="tool-error"
                initial={{ opacity: 0, x: 0 }}
                animate={{ opacity: 1, x: [0, -6, 6, -3, 3, 0] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
                className="flex items-start gap-2 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Action */}
          <AnimatePresence>
            {entries.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-3"
              >
                {status === "working" ? (
                  <div className="w-full max-w-md" aria-live="polite">
                    <div className="relative h-3 overflow-hidden rounded-full bg-secondary">
                      {progress ? (
                        <motion.div
                          className="h-full rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400"
                          animate={{ width: `${Math.max(4, progress.fraction * 100)}%` }}
                          transition={{ ease: "easeOut", duration: 0.3 }}
                        />
                      ) : (
                        // Indeterminate: a comet sweeping across the track.
                        <motion.div
                          className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent"
                          animate={{ x: ["-100%", "300%"] }}
                          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                        />
                      )}
                    </div>
                    <p className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        className="inline-flex"
                      >
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                      </motion.span>
                      {progress?.label ?? "Casting…"}
                      {progress && (
                        <span className="tabular-nums">{Math.round(progress.fraction * 100)}%</span>
                      )}
                    </p>
                  </div>
                ) : (
                  <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} transition={SPRING}>
                    <Button size="lg" onClick={run} className="min-w-52 shadow-lg shadow-primary/25">
                      <Sparkles /> Cast spell
                    </Button>
                  </motion.div>
                )}
                {proc.note && (
                  <p className="max-w-md text-center text-xs text-muted-foreground">{proc.note}</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
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
