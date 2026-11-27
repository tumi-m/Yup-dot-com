"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CloudUpload, Download, FileSpreadsheet, FileType, RotateCcw, Sparkles, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import {
  DEFAULT_SHEET_OPTIONS,
  OFFICE_TOKEN_HEADER,
  officeAccept,
  officeExtension,
  officeFormatList,
  officePdfName,
  officeTypeProblem,
  workerFailure,
  type OfficeTool,
  type SheetOptions,
} from "@/lib/office";
import { cn, formatBytes } from "@/lib/utils";

const NEXT_STEPS = ["compress-pdf", "merge-pdf", "sign-pdf"];

type Status = "idle" | "ready" | "working" | "done";
/** Where a conversion is: the upload, the server's turn, the PDF coming back. */
type Phase = { stage: "upload" | "convert" | "receive"; value: number | null };

type Sent = { ok: true; blob: Blob; pages: number | null } | { ok: false; status: number; body: Record<string, unknown> | null; aborted?: boolean };

/**
 * The file goes straight to the media worker (fetch can't report upload
 * progress, so this is XHR) and the PDF comes back in the same response.
 */
function sendToWorker(url: string, token: string, file: File, onPhase: (p: Phase) => void, signal: AbortSignal): Promise<Sent> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${url}/convert/office`);
    xhr.responseType = "blob";
    xhr.setRequestHeader(OFFICE_TOKEN_HEADER, token);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onPhase({ stage: "upload", value: e.lengthComputable ? e.loaded / e.total : null });
    xhr.upload.onload = () => onPhase({ stage: "convert", value: null });
    xhr.onprogress = (e) => {
      if (e.loaded > 0) onPhase({ stage: "receive", value: e.lengthComputable ? e.loaded / e.total : null });
    };
    xhr.onload = async () => {
      if (xhr.status === 200) {
        const pages = Number(xhr.getResponseHeader("X-Page-Count"));
        return resolve({ ok: true, blob: new Blob([xhr.response], { type: "application/pdf" }), pages: Number.isFinite(pages) && pages > 0 ? pages : null });
      }
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await (xhr.response as Blob).text());
      } catch {
        // A proxy's or a sleeping host's page.
      }
      resolve({ ok: false, status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, body: null });
    xhr.onabort = () => resolve({ ok: false, status: 0, body: null, aborted: true });
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Gives a conversion back when it failed or never ran (the server asks the worker). */
function refund(token: string) {
  void fetch("/api/convert/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => null);
}

function seconds(s: number) {
  return s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(1)} s`;
}

const ORIENTATIONS: [SheetOptions["orientation"], string][] = [
  ["auto", "Automatic"],
  ["portrait", "Portrait"],
  ["landscape", "Landscape"],
];

export function OfficeToPdf({ tool, tier }: { tool: OfficeTool; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const sheet = tool === "excel-to-pdf";
  const limits = limitsFor(tier);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [phase, setPhase] = useState<Phase | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<SheetOptions>(DEFAULT_SHEET_OPTIONS);
  const [result, setResult] = useState<{ blob: Blob; pages: number | null; seconds: number } | null>(null);
  /** The PDF has been downloaded at least once, so leaving doesn't lose it. */
  const [downloaded, setDownloaded] = useState(false);
  /** Conversions left today, as the last upload link said. */
  const [left, setLeft] = useState<number | null>(null);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** The grant of the conversion under way, to give back if it is cancelled. */
  const grant = useRef<string | null>(null);
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done" | "convert" | "choose" | "cancel">();
  const flow = useHeightLock<HTMLDivElement>();
  const FileIcon = sheet ? FileSpreadsheet : FileType;
  const isCsv = officeExtension(file?.name ?? "") === "csv";

  // Leaving the page mid-way stops the conversion and gives it back.
  useEffect(
    () => () => {
      abort.current?.abort();
      if (grant.current) refund(grant.current);
    },
    []
  );

  // Seconds since the upload finished, while the server converts.
  useEffect(() => {
    if (phase?.stage !== "convert") return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase?.stage]);

  function open(list: FileList | File[] | null) {
    const picked = list?.length ? Array.from(list)[0] : null;
    if (!picked) return;
    setError(null);
    const problem = officeTypeProblem(tool, picked.name);
    if (problem) return setError(problem);
    if (picked.size === 0) return setError("This file is empty.");
    if (picked.size > limits.officeMaxBytes) {
      if (tier !== "pro" && tier !== "team") setUpsell("office-size");
      return setError(`Files up to ${formatLimitBytes(limits.officeMaxBytes)} on your plan.`);
    }
    if (flow.ref.current?.contains(document.activeElement) || document.activeElement === document.body) focusNext.current = "convert";
    setFile(picked);
    setResult(null);
    setStatus("ready");
  }

  async function convert(retried = false) {
    if (!file) return;
    const hadFocus = !!flow.ref.current?.contains(document.activeElement) || document.activeElement === document.body;
    flow.lock(resultFloor());
    setError(null);
    setNextFailed(null);
    setPhase({ stage: "upload", value: 0 });
    setStatus("working");
    focusNext.current = "cancel";
    const controller = new AbortController();
    abort.current = controller;
    const started = performance.now();
    const back = (message: string | null) => {
      if (abort.current === controller) abort.current = null;
      setPhase(null);
      setError(message);
      if (hadFocus) focusNext.current = "convert";
      flow.release();
      setStatus("ready");
    };

    const res = await fetch("/api/convert/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, name: file.name, size: file.size, ...(sheet ? { options: isCsv ? { ...options, sheets: "all" } : options } : {}) }),
      signal: controller.signal,
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (controller.signal.aborted) return;
    if (!res?.ok || !data?.token) {
      if (data?.upgrade) setUpsell(data.reason === "size" ? "office-size" : "office");
      if (res?.status === 429 && data?.reason === "quota") setLeft(0);
      return back(data?.error ?? (res ? "Couldn't start the conversion. Try again." : "You're offline. Check your connection."));
    }
    setLeft(typeof data.remaining === "number" ? data.remaining : null);
    grant.current = data.token;

    const sent = await sendToWorker(data.workerUrl, data.token, file, setPhase, controller.signal);
    if (controller.signal.aborted || (!sent.ok && sent.aborted)) return;
    if (!sent.ok) {
      grant.current = null;
      refund(data.token);
      const failure = workerFailure(sent.status, sent.body as { error?: unknown; code?: unknown } | null);
      if (failure.retry && !retried) {
        abort.current = null;
        return convert(true);
      }
      return back(failure.message);
    }
    grant.current = null;
    const took = (performance.now() - started) / 1000;
    // Let the bar visibly finish before the result replaces it.
    setPhase({ stage: "receive", value: 1 });
    if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
    if (controller.signal.aborted) return;
    abort.current = null;
    setResult({ blob: sent.blob, pages: sent.pages, seconds: took });
    setDownloaded(false);
    setPhase(null);
    if (hadFocus || document.activeElement === document.body) focusNext.current = "done";
    settleSlot(flow.ref.current);
    setStatus("done");
    trackToolUsed(tool);
    setShowCard(!upsellCardDismissed());
    if (recordTask(tier === "guest")) nudge.arm();
  }

  function cancel() {
    abort.current?.abort();
    abort.current = null;
    if (grant.current) refund(grant.current);
    grant.current = null;
    setPhase(null);
    focusNext.current = "convert";
    flow.release();
    setStatus("ready");
  }

  function reset() {
    nudge.cancel();
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "choose";
    if (status === "done") flow.lock();
    else flow.release();
    setFile(null);
    setResult(null);
    setError(null);
    setStatus("idle");
  }

  async function continueWith(nextSlug: string) {
    nudge.cancel();
    if (!result || !file) return;
    setNextFailed(null);
    if (await tryHandoff([fileToHandoff(result.blob, officePdfName(file.name))])) router.push(`/tools/${nextSlug}?handoff=1`);
    else setNextFailed(nextSlug);
  }

  // A file handed over from the homepage.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        const match = handed.find((h) => !officeTypeProblem(tool, h.name)) ?? handed[0];
        if (match) open([handoffToFile(match)]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = phase
    ? phase.stage === "upload"
      ? "Uploading"
      : phase.stage === "convert"
        ? `Converting on our server${elapsed >= 2 ? ` · ${elapsed} s` : "…"}`
        : "Getting your PDF"
    : "";
  const amount = phase?.stage === "convert" ? null : phase?.value ?? null;

  return (
    <>
      {/* Says each stage once, not every percent. */}
      <p className="sr-only" aria-live="polite">
        {status === "working" && phase ? (phase.stage === "upload" ? "Uploading…" : phase.stage === "convert" ? "Converting…" : "Getting your PDF…") : ""}
      </p>
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
                    <Timer className="h-3 w-3" /> {seconds(result.seconds)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                    {result.pages ? `${result.pages} page${result.pages === 1 ? "" : "s"} · ` : ""}
                    {formatBytes(result.blob.size)}
                  </span>
                </>
              }
              actions={
                <>
                  <Button
                    onClick={() => {
                      nudge.downloaded();
                      setDownloaded(true);
                      downloadBlob(result.blob, officePdfName(file.name));
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
              next={{ slugs: NEXT_STEPS, onPick: (next) => void continueWith(next), failed: nextFailed }}
              upsell={
                showCard && (
                  <UpsellCard
                    tier={tier}
                    returnTo={`/tools/${tool}`}
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
              <input
                ref={inputRef}
                type="file"
                accept={officeAccept(tool)}
                className="hidden"
                hidden
                aria-hidden
                tabIndex={-1}
                data-testid="office-input"
                onChange={(e) => {
                  open(e.target.files);
                  e.target.value = "";
                }}
              />

              {!file ? (
                <ToolDropzone label={sheet ? "Drop a spreadsheet here" : "Drop a Word file here"} onFiles={open} icon={FileIcon}>
                  <p className="text-sm text-muted-foreground">or</p>
                  <Button ref={focusRef("choose")} className="mt-3 h-11" onClick={() => inputRef.current?.click()}>
                    Choose file
                  </Button>
                  <p className="mt-4 text-xs text-muted-foreground">
                    {officeFormatList(tool)}, up to {formatLimitBytes(limits.officeMaxBytes)}.
                  </p>
                  <UploadNote className="mx-auto mt-2 max-w-sm justify-center text-center" />
                </ToolDropzone>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={ENTER.animate}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <FileIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
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

              {file && sheet && status === "ready" && (
                <motion.fieldset initial={ENTER.initial} animate={ENTER.animate} className="rounded-2xl border border-border bg-card p-4">
                  <legend className="sr-only">Page setup</legend>
                  <div className="space-y-4">
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                      checked={options.fit}
                      onChange={(e) => setOptions((o) => ({ ...o, fit: e.target.checked }))}
                      data-testid="opt-fit"
                    />
                    <span>
                      Fit each sheet&apos;s width to the page
                      <span className="block text-xs text-muted-foreground">Wide sheets get smaller instead of running onto more pages.</span>
                    </span>
                  </label>
                  <Choice
                    legend="Orientation"
                    name="orientation"
                    value={options.orientation}
                    choices={ORIENTATIONS}
                    onChange={(orientation) => setOptions((o) => ({ ...o, orientation }))}
                  />
                  {!isCsv && (
                    <Choice
                      legend="Sheets"
                      name="sheets"
                      value={options.sheets}
                      choices={[
                        ["all", "All sheets"],
                        ["first", "First sheet only"],
                      ]}
                      onChange={(sheets) => setOptions((o) => ({ ...o, sheets }))}
                    />
                  )}
                  </div>
                </motion.fieldset>
              )}

              <AnimatePresence>{error && <InlineError key="error" message={error} />}</AnimatePresence>

              {file && (status === "ready" || status === "working") && (
                <motion.div initial={ENTER.initial} animate={ENTER.animate} className="relative flex flex-col items-center gap-3">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {status === "working" ? (
                      <motion.div key="progress" initial={HANDOFF.in.initial} animate={HANDOFF.in.animate} exit={FADE_EXIT} className="w-full max-w-md">
                        <motion.div initial={HANDOFF.track.initial} animate={HANDOFF.track.animate}>
                          <ProgressBar value={amount} determinate={amount !== null} label={label} />
                        </motion.div>
                        <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-sm text-muted-foreground">
                          <WorkingGlyph />
                          <span aria-hidden className="inline-flex gap-1.5 tabular-nums">
                            {label}
                            {amount !== null && <ProgressPercent value={amount} />}
                          </span>
                          <Button ref={focusRef("cancel")} variant="ghost" size="sm" className="tap ml-1" onClick={cancel} data-testid="cancel-convert">
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
                        className="flex flex-col items-center gap-3"
                      >
                        <Button
                          ref={focusRef("convert")}
                          size="lg"
                          onClick={() => void convert()}
                          disabled={left === 0}
                          className="min-w-52 shadow-lg shadow-primary/25"
                          data-testid="convert"
                        >
                          <Sparkles /> Convert to PDF
                        </Button>
                        <UploadNote className="max-w-sm justify-center text-center" />
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {left !== null && left <= 2 && (
                    <p className="text-xs text-muted-foreground" data-testid="left">
                      {left === 0 ? "No conversions left today." : `${left} ${left === 1 ? "conversion" : "conversions"} left today.`}
                    </p>
                  )}
                </motion.div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {upsell && <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo={`/tools/${tool}`} />}
    </>
  );
}

/** Said plainly before anything is sent: this tool uploads, unlike most of the site. */
function UploadNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)} data-testid="upload-note">
      <CloudUpload className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>Unlike most of our tools, this one uploads your file to our server to convert it. It&apos;s deleted straight after.</span>
    </p>
  );
}

/** A row of radio buttons styled as a segmented control; the arrow keys move within it. */
function Choice<T extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
}: {
  legend: string;
  name: string;
  value: T;
  choices: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {choices.map(([v, text]) => (
          <label
            key={v}
            className={cn(
              "tap flex min-h-11 cursor-pointer items-center rounded-lg border px-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              value === v ? "border-primary bg-primary/10 font-medium text-foreground" : "border-border text-muted-foreground hover:border-primary/50"
            )}
          >
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} className="sr-only" data-testid={`opt-${name}-${v}`} />
            {text}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
