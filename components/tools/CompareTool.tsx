"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowLeftRight, Download, File as FileIcon, FileDiff, Info, Loader2, RotateCcw, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { CompareView } from "./CompareView";
import { isPdf, readPdf } from "./read-pdf";
import { ErrorHelp } from "./ErrorHelp";
import { emptyMessage, takesMessage } from "./file-pick";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { friendlyPdfError } from "@/lib/pdf/errors";
import { getTool } from "@/lib/tools";
import type { LoadedPdf } from "@/lib/pdf/render";
import type { Compared } from "@/lib/pdf/compare/run";
import { exportNames, identical, pagesText, placeFiles, SIDE_LABEL, type Side } from "@/lib/pdf/compare/view";
import { cn, formatBytes } from "@/lib/utils";

/** Where the changed version can go next. */
const NEXT_STEPS = ["edit-pdf", "sign-pdf", "merge-pdf", "compress-pdf"];

type Status = "idle" | "working" | "done";

export interface Source {
  file: File;
  loaded: LoadedPdf;
  pages: number;
}

interface Download {
  key: string;
  name: string;
  blob: Blob;
}

interface Result {
  compared: Compared;
  downloads: Download[];
  /** What the marked copies couldn't include. */
  notes: string[];
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const SIDES: Side[] = ["a", "b"];

export function CompareTool({ slug, tier }: { slug: string; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const inputs = { a: useRef<HTMLInputElement>(null), b: useRef<HTMLInputElement>(null) };

  const [sources, setSources] = useState<Record<Side, Source | null>>({ a: null, b: null });
  const [reading, setReading] = useState<Record<Side, boolean>>({ a: false, b: false });
  const [status, setStatus] = useState<Status>("idle");
  const [looks, setLooks] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  /** The file the error is about, for the link to a tool that can help. */
  const [failedFile, setFailedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done" | "run" | "choose-a" | "choose-b" | "file-a" | "file-b">();
  const flow = useHeightLock<HTMLDivElement>();
  /** The running comparison; aborted on Cancel, on a new file and when the page goes away. */
  const job = useRef<AbortController | null>(null);
  /** Bumps for every file opened on a side, so a slow read can't land after a newer one. */
  const opened = useRef<Record<Side, number>>({ a: 0, b: 0 });

  // pdf.js keeps each document (and its worker's memory) until destroyed.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  useEffect(
    () => () => {
      job.current?.abort();
      for (const side of SIDES) sourcesRef.current[side]?.loaded.destroy();
    },
    []
  );

  function fail(message: string | null, file: File | null = null) {
    setError(message);
    setFailedFile(file);
    if (message) setErrorKey((k) => k + 1);
  }

  function say(message: string) {
    setNote((prev) => (prev === message ? `${message} ` : message));
  }

  /** Back from a result to the files, as they were. */
  function leaveResult() {
    job.current?.abort();
    nudge.cancel();
    setResult(null);
    setStatus("idle");
  }

  /** `together`: placed with the other file at once; what to say is returned, to be said once for both. */
  async function openOn(side: Side, picked: File, together = false): Promise<string | null> {
    const empty = emptyMessage([picked]);
    if (empty) {
      fail(empty);
      return null;
    }
    // Limits are an upgrade prompt, never a silent failure.
    if (picked.size > limits.maxFileBytes) {
      setUpsell("file-size");
      fail(`${picked.name}: files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return null;
    }
    const id = ++opened.current[side];
    const hadFocus = !!flow.ref.current?.contains(document.activeElement);
    setReading((r) => ({ ...r, [side]: true }));
    try {
      const loaded = await readPdf(picked);
      if (id !== opened.current[side]) {
        loaded.destroy();
        return null;
      }
      if (loaded.numPages > limits.comparePages) {
        loaded.destroy();
        setUpsell("pages");
        fail(`${picked.name} has ${plural(loaded.numPages, "page")}. Compare PDFs reads up to ${plural(limits.comparePages, "page")} a file on your plan.`);
        return null;
      }
      sourcesRef.current[side]?.loaded.destroy();
      setSources((s) => ({ ...s, [side]: { file: picked, loaded, pages: loaded.numPages } }));
      const message = `${SIDE_LABEL[side]}: ${picked.name}, ${plural(loaded.numPages, "page")}.`;
      if (hadFocus) focusNext.current = side === "a" ? "file-a" : "file-b";
      if (together) return message;
      if (!hadFocus) say(message);
    } catch (err) {
      if (id !== opened.current[side]) return null;
      fail(friendlyPdfError(err, picked.name).message, picked);
      if (hadFocus) focusNext.current = side === "a" ? "choose-a" : "choose-b";
    } finally {
      if (id === opened.current[side]) setReading((r) => ({ ...r, [side]: false }));
    }
    return null;
  }

  function open(list: FileList | File[] | null, side: Side) {
    if (!list?.length) return;
    const pdfs = Array.from(list).filter(isPdf);
    if (!pdfs.length) {
      fail(takesMessage(getTool(slug)?.name, "application/pdf", true));
      return;
    }
    leaveResult();
    fail(null);
    const placed = placeFiles(pdfs, side);
    const extra = list.length > 2 ? "Two files are compared at a time: the first two were taken." : "";
    // Two files at once are read out together: a second message would replace the first.
    void Promise.all(placed.map(({ side: to, file }) => openOn(to, file, placed.length > 1))).then((said) => {
      const text = [...said.filter(Boolean), extra].filter(Boolean).join(" ");
      if (text) say(text);
    });
  }

  function remove(side: Side) {
    opened.current[side]++;
    sources[side]?.loaded.destroy();
    setSources((s) => ({ ...s, [side]: null }));
    setReading((r) => ({ ...r, [side]: false }));
    fail(null);
    focusNext.current = side === "a" ? "choose-a" : "choose-b";
  }

  function swap() {
    opened.current.a++;
    opened.current.b++;
    setSources((s) => ({ a: s.b, b: s.a }));
    say(`Swapped. Original: ${sources.b?.file.name ?? "none"}. Changed version: ${sources.a?.file.name ?? "none"}.`);
  }

  async function run() {
    const { a, b } = sources;
    if (!a || !b) {
      fail(`Choose the ${!a ? "original" : "changed version"}${!a && !b ? " and the changed version" : ""} first.`);
      return;
    }
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "run";
    flow.lock(resultFloor());
    setStatus("working");
    fail(null);
    setProgress(null);
    setNextFailed(null);
    const started = performance.now();
    const ctl = new AbortController();
    job.current = ctl;
    try {
      const { compareDocuments } = await import("@/lib/pdf/compare/run");
      const compared = await compareDocuments(
        { file: a.file, name: a.file.name, loaded: a.loaded },
        { file: b.file, name: b.file.name, loaded: b.loaded },
        { looks, signal: ctl.signal, progress: (fraction, label) => !ctl.signal.aborted && setProgress({ fraction, label }) }
      );
      if (ctl.signal.aborted) return;
      const seconds = (performance.now() - started) / 1000;
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      const names = exportNames(a.file.name, b.file.name);
      const pdf = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
      const { exports } = compared;
      const downloads: Download[] = [
        { key: "report", name: names.report, blob: pdf(exports.report) },
        ...(exports.markedB ? [{ key: "b", name: names.markedB, blob: pdf(exports.markedB) }] : []),
        ...(exports.markedA ? [{ key: "a", name: names.markedA, blob: pdf(exports.markedA) }] : []),
      ];
      const notes = exports.unmarked.map((u) => `${(u.side === "a" ? a : b).file.name} couldn't be marked (${u.message.replace(/\.$/, "")}); the report lists its changes.`);
      setResult({ compared, downloads, notes });
      setDownloaded(false);
      setElapsed(seconds);
      if (focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "done";
      }
      settleSlot(flow.ref.current);
      setStatus("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch (err) {
      if (ctl.signal.aborted) return;
      const message = friendlyPdfError(err).message;
      const named = SIDES.map((s) => sources[s]?.file).find((f) => f && message.startsWith(`${f.name}:`)) ?? null;
      fail(message, named);
      if (focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "run";
      }
      flow.release();
      setStatus("idle");
    } finally {
      if (job.current === ctl) {
        job.current = null;
        setProgress(null);
      }
    }
  }

  function cancel() {
    job.current?.abort();
    job.current = null;
    setProgress(null);
    focusNext.current = "run";
    flow.release();
    setStatus("idle");
  }

  function reset() {
    job.current?.abort();
    nudge.cancel();
    opened.current.a++;
    opened.current.b++;
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "choose-a";
    if (status === "done") flow.lock();
    else flow.release();
    for (const side of SIDES) sources[side]?.loaded.destroy();
    setSources({ a: null, b: null });
    setReading({ a: false, b: false });
    setResult(null);
    fail(null);
    setStatus("idle");
  }

  /** Back to the two files, to swap them or pick another. */
  function changeFiles() {
    nudge.cancel();
    flow.lock();
    setResult(null);
    focusNext.current = "run";
    setStatus("idle");
  }

  function save(d: Download) {
    nudge.downloaded();
    setDownloaded(true);
    downloadBlob(d.blob, d.name);
  }

  async function continueWith(nextSlug: string) {
    nudge.cancel();
    if (!result) return;
    setNextFailed(null);
    // The changed version goes on, with its changes marked when there are any.
    const marked = result.downloads.find((d) => d.key === "b");
    const file = marked ? marked.blob : sources.b?.file;
    const name = marked ? marked.name : sources.b?.file.name;
    if (!file || !name) return;
    if (await tryHandoff([fileToHandoff(file, name)])) router.push(`/tools/${nextSlug}?handoff=1`);
    else setNextFailed(nextSlug);
  }

  // Files handed over from the homepage or another tool: the first is the original, a second the changed version.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        if (handed.length) open(handed.map(handoffToFile), "a");
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const working = status === "working";
  const both = !!sources.a && !!sources.b;
  const r = result?.compared.result;
  const same = r ? identical(r) : false;

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {note}
      </p>
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
        <AnimatePresence mode="wait" initial={false}>
          {status === "done" && result && r ? (
            <motion.div key="done" className="flex flex-1 flex-col gap-6" exit={{ opacity: 0, transition: { duration: 0.15 } }}>
              <SuccessCard
                className="flex-1"
                title={same ? "No differences found" : `${plural(r.summary.changes || r.summary.pagesAdded.length + r.summary.pagesRemoved.length, "difference")} found`}
                titleRef={focusRef("done")}
                files={result.downloads.map((d) => ({ name: d.name, size: d.blob.size, onDownload: () => save(d) }))}
                stats={
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                      <Timer className="h-3 w-3" /> {elapsed < 1 ? `${Math.round(elapsed * 1000)} ms` : `${elapsed.toFixed(1)} s`}
                    </span>
                    {(r.summary.wordsAdded > 0 || r.summary.wordsRemoved > 0) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                        {plural(r.summary.wordsAdded, "word")} added · {plural(r.summary.wordsRemoved, "word")} taken out
                      </span>
                    )}
                    {(r.summary.pagesAdded.length > 0 || r.summary.pagesRemoved.length > 0) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                        {[
                          r.summary.pagesAdded.length && `${plural(r.summary.pagesAdded.length, "page")} added`,
                          r.summary.pagesRemoved.length && `${plural(r.summary.pagesRemoved.length, "page")} taken out`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    )}
                    {(r.scanned.a.length > 0 || r.scanned.b.length > 0) && (
                      <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-left font-medium text-amber-800">
                        <Info className="mt-0.5 h-3 w-3 shrink-0" />
                        {scannedNote(r.scanned)}
                      </span>
                    )}
                    {result.notes.map((n) => (
                      <span key={n} className="inline-flex max-w-full items-start gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-left font-medium text-amber-800">
                        <Info className="mt-0.5 h-3 w-3 shrink-0" />
                        {n}
                      </span>
                    ))}
                  </>
                }
                actions={
                  <>
                    <Button onClick={() => save(result.downloads[0])} size="lg" className="min-w-44 shadow-lg shadow-primary/25" data-testid="download">
                      <Download /> Download report
                    </Button>
                    <Button onClick={changeFiles} variant="outline" size="lg">
                      <ArrowLeftRight /> Change files
                    </Button>
                    <Button onClick={reset} variant="ghost" size="lg">
                      <RotateCcw /> Start over
                    </Button>
                  </>
                }
                next={{ slugs: NEXT_STEPS, onPick: (next) => void continueWith(next), failed: nextFailed }}
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
              {sources.a && sources.b && (
                // Wider than the column on a big screen, so two pages side by side can be read.
                <div className="lg:relative lg:left-1/2 lg:w-[min(72rem,calc(100vw_-_4rem))] lg:-translate-x-1/2">
                  <CompareView compared={result.compared} a={sources.a} b={sources.b} reduce={!!reduce} />
                </div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="work"
              initial={ENTER.initial}
              animate={ENTER.animate}
              exit={EXIT}
              onAnimationStart={(def) => def !== EXIT && flow.release()}
              className="space-y-5"
            >
              <fieldset disabled={working} className="min-w-0">
                <legend className="sr-only">The two files</legend>
                <div className="grid items-stretch gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  {SIDES.map((side) => (
                    <div key={side} className={cn("min-w-0", side === "b" && "sm:order-3")}>
                      <input
                        ref={inputs[side]}
                        type="file"
                        accept="application/pdf,.pdf"
                        multiple
                        className="hidden"
                        hidden
                        aria-hidden
                        tabIndex={-1}
                        data-testid={`pdf-input-${side}`}
                        onChange={(e) => {
                          open(e.target.files, side);
                          e.target.value = "";
                        }}
                      />
                      <SideSlot
                        side={side}
                        source={sources[side]}
                        reading={reading[side]}
                        working={working}
                        limit={formatLimitBytes(limits.maxFileBytes)}
                        chooseRef={focusRef(side === "a" ? "choose-a" : "choose-b")}
                        fileRef={focusRef(side === "a" ? "file-a" : "file-b")}
                        onChoose={() => inputs[side].current?.click()}
                        onFiles={(files) => open(files, side)}
                        onRemove={() => remove(side)}
                      />
                    </div>
                  ))}
                  <div className="flex items-center justify-center sm:order-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10 gap-1.5 rounded-full pointer-coarse:h-11"
                      onClick={swap}
                      disabled={!sources.a && !sources.b}
                      aria-label="Swap the original and the changed version"
                      data-testid="swap"
                    >
                      <ArrowLeftRight className="h-4 w-4 sm:rotate-0" /> <span className="sm:hidden">Swap</span>
                    </Button>
                  </div>
                </div>

                {both && (
                  <motion.div initial={ENTER.initial} animate={ENTER.animate} className="mt-4 rounded-2xl border border-border bg-card p-4">
                    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium sm:min-h-10">
                      <input
                        type="checkbox"
                        checked={looks}
                        onChange={(e) => setLooks(e.target.checked)}
                        aria-describedby="compare-looks-hint"
                        className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                      />
                      Also compare pictures and drawings on every page
                    </label>
                    <p id="compare-looks-hint" className="pl-[30px] text-xs text-muted-foreground">
                      {looks
                        ? "Each pair of pages is drawn and compared, so a changed logo, chart or line shows up too. Slower on long files."
                        : "Off: words are compared on every page; pages without text (scans) are compared by how they look."}
                    </p>
                  </motion.div>
                )}
              </fieldset>

              <AnimatePresence>
                {error && (
                  <InlineError
                    key="error"
                    shakeKey={errorKey}
                    message={<ErrorHelp message={error} slug={slug} files={failedFile ? [failedFile] : []} onLeave={nudge.cancel} />}
                  />
                )}
              </AnimatePresence>

              {(sources.a || sources.b) && (
                <motion.div initial={ENTER.initial} animate={ENTER.animate} exit={FADE_EXIT} className="relative flex flex-col items-center gap-3">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {working ? (
                      <motion.div
                        key="progress"
                        tabIndex={-1}
                        data-progress
                        initial={HANDOFF.in.initial}
                        animate={HANDOFF.in.animate}
                        exit={FADE_EXIT}
                        className="w-full max-w-md rounded-xl outline-none"
                      >
                        <motion.div initial={HANDOFF.track.initial} animate={HANDOFF.track.animate}>
                          <ProgressBar value={progress?.fraction} label="Progress" />
                        </motion.div>
                        <p aria-hidden className="mt-2 flex items-center justify-center gap-1.5 text-center text-sm text-muted-foreground">
                          <WorkingGlyph />
                          <span className="relative min-w-0 truncate">{progress?.label ?? "Casting…"}</span>
                          <ProgressPercent value={progress?.fraction} />
                        </p>
                        <p className="sr-only" aria-live="polite">
                          {progressNote(progress)}
                        </p>
                        <div className="mt-2 flex justify-center">
                          <Button variant="ghost" className="h-11 text-muted-foreground" onClick={cancel} data-testid="cancel">
                            <X /> Cancel
                          </Button>
                        </div>
                      </motion.div>
                    ) : (
                      <motion.div key="cast" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1, transition: NOTICE_T }} exit={HANDOFF.out}>
                        <Button
                          ref={focusRef("run")}
                          size="lg"
                          onClick={run}
                          data-cast
                          data-testid="run"
                          className="min-w-52 shadow-lg shadow-primary/25"
                          disabled={reading.a || reading.b}
                        >
                          <FileDiff /> Compare PDFs
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
      {upsell && <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo={`/tools/${slug}`} />}
    </>
  );
}

/** Reading and comparing are told in steps, not every page, so a screen reader isn't still reading when it's done. */
function progressNote(p: { fraction: number; label: string } | null): string {
  if (!p) return "Comparing…";
  const quarter = Math.min(3, Math.floor(p.fraction * 4));
  return quarter <= 0 ? "Comparing…" : `${quarter * 25}% done`;
}

function scannedNote(scanned: { a: number[]; b: number[] }): ReactNode {
  const parts = [
    scanned.a.length && `${pagesText(scanned.a)} of the original`,
    scanned.b.length && `${pagesText(scanned.b)} of the changed version`,
  ].filter(Boolean);
  const list = parts.join(" and ");
  return (
    <span>
      No text on {list}: compared by how they look. Overlay shows them; run{" "}
      <Link href="/tools/ocr-pdf" className="underline underline-offset-2">
        OCR PDF
      </Link>{" "}
      first to compare their words.
    </span>
  );
}

/** One side: a drop zone until a file is chosen, then the file. */
function SideSlot({
  side,
  source,
  reading,
  working,
  limit,
  chooseRef,
  fileRef,
  onChoose,
  onFiles,
  onRemove,
}: {
  side: Side;
  source: Source | null;
  reading: boolean;
  working: boolean;
  limit: string;
  chooseRef: React.Ref<HTMLButtonElement>;
  fileRef: React.Ref<HTMLDivElement>;
  onChoose: () => void;
  onFiles: (files: FileList) => void;
  onRemove: () => void;
}) {
  const label = SIDE_LABEL[side];
  if (!source) {
    return (
      <ToolDropzone
        label={label}
        onFiles={onFiles}
        busy={reading}
        className="h-full p-6 sm:p-6"
        tileClassName={side === "a" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}
        data-testid={`drop-${side}`}
      >
        <p className="text-xs text-muted-foreground">{side === "a" ? "The earlier file" : "The later file"}</p>
        <Button ref={chooseRef} className="mt-3 h-11" onClick={onChoose} disabled={reading} aria-label={`Choose the ${label.toLowerCase()}`}>
          {reading ? <Loader2 className="motion-safe:animate-spin" /> : null}
          {reading ? "Reading pages…" : "Choose file"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">Up to {limit} · Stays on your device.</p>
      </ToolDropzone>
    );
  }
  return (
    <motion.div
      ref={fileRef}
      tabIndex={-1}
      initial={{ opacity: 0, y: -6 }}
      animate={ENTER.animate}
      className="flex h-full min-h-[88px] items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`file-${side}`}
    >
      <span
        aria-hidden
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          side === "a" ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"
        )}
      >
        <FileIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium" title={source.file.name}>
          {source.file.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(source.file.size)} · {plural(source.pages, "page")}
        </p>
      </div>
      {!working && (
        <button
          type="button"
          onClick={onRemove}
          className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:p-2.5"
          aria-label={`Remove ${source.file.name}`}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </motion.div>
  );
}

