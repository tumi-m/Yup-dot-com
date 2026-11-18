"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronLeft, ChevronRight, Crop, Download, File as FileIcon, Info, Loader2, Pencil, RotateCcw, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { isPdf, readPdf } from "./read-pdf";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { friendlyPdfError } from "@/lib/pdf/errors";
import { ErrorHelp } from "./ErrorHelp";
import { takesMessage } from "./file-pick";
import { getTool } from "@/lib/tools";
import type { LoadedPdf } from "@/lib/pdf/render";
import {
  GRIPS,
  boxBetween,
  boxFromMargins,
  clampBox,
  croppedName,
  describeBox,
  dragBox,
  formatLength,
  hasMargins,
  marginsFromBox,
  marginsProblem,
  nudgeBox,
  readLength,
  scopePages,
  toPoints,
  type Box,
  type Edge,
  type Grip,
  type Margins,
  type Scope,
  type Size,
  type Unit,
} from "@/lib/pdf/crop/geometry";
import { cn, formatBytes } from "@/lib/utils";

/** Where a cropped PDF can go next. */
const NEXT_STEPS = ["compress-pdf", "resize-pdf", "page-numbers", "edit-pdf"];

type Status = "idle" | "reading" | "ready" | "working" | "done";
type Mode = "box" | "trim";

interface Source {
  file: File;
  loaded: LoadedPdf;
  pages: number;
}

interface Result {
  blob: Blob;
  name: string;
  cropped: number;
  pictured: number;
  removed: number;
  skipped: number;
}

const EDGES: { edge: Edge; label: string }[] = [
  { edge: "top", label: "Top" },
  { edge: "right", label: "Right" },
  { edge: "bottom", label: "Bottom" },
  { edge: "left", label: "Left" },
];

const SCOPES: { value: Scope; label: string }[] = [
  { value: "all", label: "All pages" },
  { value: "current", label: "This page" },
  { value: "odd", label: "Odd pages" },
  { value: "even", label: "Even pages" },
  { value: "range", label: "Pages…" },
];

const DPI = ["100", "150", "200", "300"];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A margin as people read it. */
const lengthText = (points: number, unit: Unit) => `${formatLength(points, unit)} ${unit}`;

/** The box a new file starts with: a little in from each edge, so it can be seen and grabbed. */
function startMargins(page: Size): Margins {
  const mm = (pt: number) => toPoints(Math.round(pt / toPoints(1, "mm")), "mm");
  const side = mm(page.width * 0.08);
  const end = mm(page.height * 0.08);
  return { top: end, right: side, bottom: end, left: side };
}

const marginTexts = (m: Margins, unit: Unit): Record<Edge, string> => ({
  top: formatLength(m.top, unit),
  right: formatLength(m.right, unit),
  bottom: formatLength(m.bottom, unit),
  left: formatLength(m.left, unit),
});

/** Labelled radio pills: native radios, so arrow keys move between them. */
function Pills<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm transition-colors pointer-coarse:min-h-11 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
              value === o.value ? "border-primary bg-primary/10 font-medium text-primary" : "border-border bg-background hover:bg-accent"
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CropTool({ slug, tier }: { slug: string; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const inputRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<Source | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  /** The page shown, 0-indexed, and its size as shown. */
  const [current, setCurrent] = useState(0);
  const [pageText, setPageText] = useState("1");
  const [view, setView] = useState<Size | null>(null);
  const [mode, setMode] = useState<Mode>("box");
  const [margins, setMargins] = useState<Margins>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [unit, setUnit] = useState<Unit>("mm");
  const [texts, setTexts] = useState<Record<Edge, string>>({ top: "0", right: "0", bottom: "0", left: "0" });
  /** A typed margin that isn't a number: which one, and why. */
  const [typedProblem, setTypedProblem] = useState<{ edge: Edge; message: string } | null>(null);
  const [padText, setPadText] = useState("3");
  /** Trim: margins found so far, by page, for the padding they were found with. */
  const [found, setFound] = useState<{ padding: number; pages: Map<number, Margins | null> }>({ padding: NaN, pages: new Map() });
  const [finding, setFinding] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [rangeText, setRangeText] = useState("");
  const [remove, setRemove] = useState(false);
  const [dpi, setDpi] = useState("150");
  const [keepText, setKeepText] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  /** Read out after the box moves from the keyboard. */
  const [note, setNote] = useState("");
  /** The file that wouldn't open, for the link to a tool that can help. */
  const [failedFile, setFailedFile] = useState<File | null>(null);
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done" | "run" | "choose" | "file">();
  const flow = useHeightLock<HTMLDivElement>();
  /** The running job; aborted on Cancel, on a new file and when the page goes away. */
  const job = useRef<AbortController | null>(null);
  /** Bumps for every file opened, so a slow read can't land after a newer one. */
  const opened = useRef(0);

  // pdf.js keeps each document (and its worker's memory) until destroyed.
  const sourceRef = useRef<Source | null>(null);
  sourceRef.current = source;
  useEffect(
    () => () => {
      job.current?.abort();
      sourceRef.current?.loaded.destroy();
    },
    []
  );

  const padding = readLength(padText, unit);

  // The size of the page shown.
  useEffect(() => {
    if (!source) return;
    let live = true;
    source.loaded
      .getPageViewport(current + 1, 1)
      .then((vp) => live && setView({ width: vp.width, height: vp.height }))
      .catch((err) => live && fail(friendlyPdfError(err).message));
    return () => {
      live = false;
    };
  }, [source, current]);

  // Trim: the margins of the page shown, found when it is shown.
  useEffect(() => {
    if (!source || mode !== "trim" || padding === null) return;
    if (found.padding === padding && found.pages.has(current)) return;
    let live = true;
    setFinding(true);
    import("@/lib/pdf/crop/pictures")
      .then(({ findPageMargins }) => findPageMargins(source.loaded, current, padding))
      .then((m) => {
        if (!live) return;
        setFound((prev) => {
          const pages = new Map(prev.padding === padding ? prev.pages : []);
          pages.set(current, m);
          return { padding, pages };
        });
      })
      .catch(() => {})
      .finally(() => live && setFinding(false));
    return () => {
      live = false;
    };
  }, [source, mode, current, padding, found]);

  function fail(message: string | null) {
    setError(message);
    if (message) setErrorKey((k) => k + 1);
  }

  function say(message: string) {
    setNote((prev) => (prev === message ? `${message} ` : message));
  }

  function dropSource() {
    sourceRef.current?.loaded.destroy();
    sourceRef.current = null;
    setSource(null);
  }

  async function open(list: FileList | File[] | null) {
    if (!list?.length) return;
    const picked = Array.from(list).find(isPdf);
    if (!picked) {
      fail(takesMessage(getTool(slug)?.name, "application/pdf", false));
      return;
    }
    // Limits are an upgrade prompt, never a silent failure.
    if (picked.size > limits.maxFileBytes) {
      setUpsell("file-size");
      fail(`Files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return;
    }
    const id = ++opened.current;
    job.current?.abort();
    const hadFocus = !!flow.ref.current?.contains(document.activeElement);
    dropSource();
    setResult(null);
    fail(null);
    setFailedFile(null);
    setStatus("reading");
    try {
      const loaded = await readPdf(picked);
      const first = await loaded.getPageViewport(1, 1);
      if (id !== opened.current) {
        loaded.destroy();
        return;
      }
      const start = startMargins(first);
      setSource({ file: picked, loaded, pages: loaded.numPages });
      setCurrent(0);
      setPageText("1");
      setView({ width: first.width, height: first.height });
      setMargins(start);
      setTexts(marginTexts(start, unit));
      setTypedProblem(null);
      setFound({ padding: NaN, pages: new Map() });
      setScope("all");
      setRangeText("");
      setStatus("ready");
      // "Choose file" goes once the PDF opens: focus moves to the file it opened, or the news is read out.
      if (hadFocus) focusNext.current = "file";
      else say(`${picked.name}, ${plural(loaded.numPages, "page")}.`);
    } catch (err) {
      if (id !== opened.current) return;
      setFailedFile(picked);
      fail(friendlyPdfError(err).message);
      if (hadFocus) focusNext.current = "choose";
      setStatus("idle");
    }
  }

  /** The box moved by a drag or a key: the margins and their fields follow. */
  function boxMoved(box: Box) {
    if (!view) return;
    const m = marginsFromBox(view, box);
    setMargins(m);
    setTexts(marginTexts(m, unit));
    setTypedProblem(null);
    fail(null);
  }

  function typeMargin(edge: Edge, text: string) {
    setTexts((t) => ({ ...t, [edge]: text }));
    fail(null);
    const points = readLength(text, unit);
    if (points === null) {
      setTypedProblem({ edge, message: `Type a ${edge} margin of 0 or more.` });
      return;
    }
    setTypedProblem(null);
    setMargins((m) => ({ ...m, [edge]: points }));
  }

  function changeUnit(next: Unit) {
    setUnit(next);
    setTexts(marginTexts(margins, next));
    setTypedProblem(null);
    // The padding keeps its length in the new unit.
    if (padding !== null) setPadText(formatLength(padding, next));
  }

  function goTo(page: number) {
    if (!source) return;
    const to = Math.max(0, Math.min(source.pages - 1, page));
    setCurrent(to);
    setPageText(String(to + 1));
  }

  const picked = source ? scopePages(scope, source.pages, current, rangeText) : { pages: [], problem: null };
  /** What's wrong with the margins on the page shown, as they are. */
  const shownProblem = mode === "box" && view ? marginsProblem(view, margins, source && source.pages > 1 ? current + 1 : undefined) : null;

  async function run() {
    if (!source) return;
    if (picked.problem) return fail(picked.problem);
    if (mode === "box") {
      if (typedProblem) return fail(typedProblem.message);
      if (shownProblem) return fail(shownProblem);
      if (!hasMargins(margins)) return fail("Drag the box's edges in, or type margins, first.");
    } else if (padding === null) {
      return fail("Type a padding of 0 or more.");
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
      const { cropDocument } = await import("@/lib/pdf/crop/run");
      const done = await cropDocument(
        source.file,
        {
          pages: picked.pages,
          cut: mode === "box" ? { margins } : { trim: { padding: padding! } },
          found: mode === "trim" && found.padding === padding ? found.pages : undefined,
          remove: remove ? { dpi: Number(dpi), keepText } : undefined,
        },
        {
          loaded: source.loaded,
          progress: (fraction, label) => !ctl.signal.aborted && setProgress({ fraction, label }),
          signal: ctl.signal,
        }
      );
      if (ctl.signal.aborted) return;
      const seconds = (performance.now() - started) / 1000;
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      setResult({
        blob: new Blob([done.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
        name: croppedName(source.file.name),
        cropped: done.report.cropped,
        pictured: done.report.pictured,
        removed: done.report.removed,
        skipped: done.skipped,
      });
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
      fail(friendlyPdfError(err).message);
      if (focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "run";
      }
      flow.release();
      setStatus("ready");
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
    setStatus("ready");
  }

  function reset() {
    job.current?.abort();
    nudge.cancel();
    opened.current++;
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "choose";
    if (status === "done") flow.lock();
    else flow.release();
    dropSource();
    setView(null);
    setResult(null);
    fail(null);
    setStatus("idle");
  }

  /** Back from the result to the box, as it was left. */
  function changeCrop() {
    nudge.cancel();
    flow.lock();
    setResult(null);
    focusNext.current = "run";
    setStatus("ready");
  }

  function saveResult() {
    if (!result) return;
    nudge.downloaded();
    setDownloaded(true);
    downloadBlob(result.blob, result.name);
  }

  async function continueWith(nextSlug: string) {
    nudge.cancel();
    if (!result) return;
    setNextFailed(null);
    if (await tryHandoff([fileToHandoff(result.blob, result.name)])) router.push(`/tools/${nextSlug}?handoff=1`);
    else setNextFailed(nextSlug);
  }

  // A file handed over from the homepage dropzone or another tool.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        if (handed.length) void open(handed.map(handoffToFile));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const working = status === "working";
  const trimHere = mode === "trim" && found.padding === padding ? found.pages.get(current) : undefined;
  const box =
    view && mode === "box" ? clampBox(boxFromMargins(view, margins), view) : view && trimHere ? boxFromMargins(view, trimHere) : null;
  const count = picked.pages.length;
  const actionLabel = scope === "all" || !count ? "Crop PDF" : `Crop ${plural(count, "page")}`;

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {note}
      </p>
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
        <AnimatePresence mode="wait" initial={false}>
          {status === "done" && result ? (
            <SuccessCard
              key="done"
              className="flex-1"
              titleRef={focusRef("done")}
              files={[{ name: result.name, size: result.blob.size, onDownload: saveResult }]}
              stats={
                <>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                    <Timer className="h-3 w-3" /> {elapsed < 1 ? `${Math.round(elapsed * 1000)} ms` : `${elapsed.toFixed(1)} s`}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                    {plural(result.cropped, "page")} cropped · {formatBytes(result.blob.size)}
                  </span>
                  <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-left font-medium text-amber-800">
                    <Info className="mt-0.5 h-3 w-3 shrink-0" />
                    {result.pictured
                      ? `What was outside the box is gone from ${result.pictured === 1 ? "that page" : "those pages"}: ${result.pictured === 1 ? "it is" : "they are"} now ${result.pictured === 1 ? "a picture" : "pictures"} of the area kept.`
                      : "What's outside the box is hidden, not deleted: it is still in the file."}
                    {result.skipped > 0 && ` ${plural(result.skipped, "page")} had no white margins and stayed as ${result.skipped === 1 ? "it was" : "they were"}.`}
                    {result.removed > 0 &&
                      ` ${result.removed} ${result.removed === 1 ? "link, note or field" : "links, notes or fields"} outside the box ${result.removed === 1 ? "was" : "were"} taken out.`}
                  </span>
                </>
              }
              actions={
                <>
                  <Button onClick={saveResult} size="lg" className="min-w-44 shadow-lg shadow-primary/25" data-testid="download">
                    <Download /> Download
                  </Button>
                  <Button onClick={changeCrop} variant="outline" size="lg">
                    <Pencil /> Change crop
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
                accept="application/pdf,.pdf"
                className="hidden"
                hidden
                aria-hidden
                tabIndex={-1}
                data-testid="pdf-input"
                onChange={(e) => {
                  open(e.target.files);
                  e.target.value = "";
                }}
              />

              {!source ? (
                <ToolDropzone label="Drop a file here" onFiles={open}>
                  <p className="text-sm text-muted-foreground">or</p>
                  <Button ref={focusRef("choose")} className="mt-3 h-11" onClick={() => inputRef.current?.click()} disabled={status === "reading"}>
                    {status === "reading" ? <Loader2 className="motion-safe:animate-spin" /> : null}
                    {status === "reading" ? "Reading pages…" : "Choose file"}
                  </Button>
                  <p className="mt-4 text-xs text-muted-foreground">
                    Up to {formatLimitBytes(limits.maxFileBytes)} · Stays on your device.
                  </p>
                </ToolDropzone>
              ) : (
                <motion.div
                  ref={focusRef("file")}
                  tabIndex={-1}
                  initial={{ opacity: 0, y: -6 }}
                  animate={ENTER.animate}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="crop-file"
                >
                  <FileIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{source.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(source.file.size)} · {plural(source.pages, "page")}
                    </p>
                  </div>
                  {!working && (
                    <button
                      onClick={reset}
                      className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove ${source.file.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </motion.div>
              )}

              {source && (
                <motion.div initial={ENTER.initial} animate={ENTER.animate}>
                  <fieldset disabled={working} className="min-w-0 space-y-4">
                    <legend className="sr-only">Crop</legend>
                    <div className="rounded-2xl border border-border bg-card p-4">
                      <Pills<Mode>
                        name="crop-mode"
                        legend="How"
                        value={mode}
                        onChange={(m) => {
                          setMode(m);
                          fail(null);
                        }}
                        options={[
                          { value: "box", label: "Draw a box" },
                          { value: "trim", label: "Trim white margins" },
                        ]}
                      />
                    </div>

                    <div className="space-y-2">
                      <PageNav
                        current={current}
                        pages={source.pages}
                        text={pageText}
                        onText={(t) => {
                          setPageText(t);
                          const n = Number(t);
                          if (Number.isInteger(n) && n >= 1 && n <= source.pages) setCurrent(n - 1);
                        }}
                        onGo={goTo}
                      />
                      <CropPreview
                        loaded={source.loaded}
                        page={current}
                        size={view}
                        box={box}
                        editable={mode === "box" && !working}
                        unit={unit}
                        onBox={boxMoved}
                        onSay={say}
                      />
                      <p id="crop-box-hint" className="text-center text-xs text-muted-foreground">
                        {mode === "box" ? (
                          <>
                            <span className="hover-none:hidden">
                              Drag the box or its handles, or draw a new one. Keys: arrows move the box, Alt + arrows resize it, Shift moves
                              10 times further.
                            </span>
                            <span className="hidden hover-none:inline">Drag the box&apos;s handles, or type the margins below.</span>
                          </>
                        ) : finding ? (
                          "Finding the edges of this page…"
                        ) : trimHere ? (
                          `This page loses ${lengthText(trimHere.top, unit)} at the top, ${lengthText(trimHere.right, unit)} on the right, ${lengthText(trimHere.bottom, unit)} at the bottom and ${lengthText(trimHere.left, unit)} on the left.`
                        ) : trimHere === null ? (
                          "Nothing to trim on this page: it stays as it is."
                        ) : (
                          ""
                        )}
                      </p>
                    </div>

                    <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
                      {mode === "box" ? (
                        <fieldset className="min-w-0">
                          <legend className="mb-1.5 text-sm font-medium">Margins to cut</legend>
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                            {EDGES.map(({ edge, label }) => (
                              <div key={edge}>
                                <label htmlFor={`crop-${edge}`} className="mb-1 block text-xs text-muted-foreground">
                                  {label}
                                </label>
                                <Input
                                  id={`crop-${edge}`}
                                  inputMode="decimal"
                                  autoComplete="off"
                                  value={texts[edge]}
                                  onChange={(e) => typeMargin(edge, e.target.value)}
                                  aria-invalid={typedProblem?.edge === edge || !!shownProblem || undefined}
                                  aria-describedby={typedProblem?.edge === edge || shownProblem ? "crop-margin-problem" : undefined}
                                  className={cn("pointer-coarse:h-11", (typedProblem?.edge === edge || shownProblem) && "border-destructive")}
                                />
                              </div>
                            ))}
                            <UnitSelect unit={unit} onChange={changeUnit} />
                          </div>
                          {(typedProblem || shownProblem) && (
                            <p id="crop-margin-problem" className="mt-1.5 text-xs text-destructive">
                              {typedProblem?.message ?? shownProblem}
                            </p>
                          )}
                        </fieldset>
                      ) : (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                          <div className="sm:col-span-2">
                            <label htmlFor="crop-padding" className="mb-1 block text-sm font-medium">
                              Space left round the content
                            </label>
                            <Input
                              id="crop-padding"
                              inputMode="decimal"
                              autoComplete="off"
                              value={padText}
                              onChange={(e) => {
                                setPadText(e.target.value);
                                fail(null);
                              }}
                              aria-invalid={padding === null || undefined}
                              aria-describedby="crop-padding-hint"
                              className={cn("pointer-coarse:h-11", padding === null && "border-destructive")}
                            />
                          </div>
                          <UnitSelect unit={unit} onChange={changeUnit} />
                          <p id="crop-padding-hint" className={cn("col-span-2 text-xs sm:col-span-5", padding === null ? "text-destructive" : "text-muted-foreground")}>
                            {padding === null
                              ? "Type a padding of 0 or more."
                              : "Each page is cut to its own content. Blank pages stay as they are."}
                          </p>
                        </div>
                      )}

                      <div className="space-y-2">
                        <Pills<Scope>
                          name="crop-scope"
                          legend="Apply to"
                          value={scope}
                          onChange={(s) => {
                            setScope(s);
                            fail(null);
                          }}
                          options={SCOPES.map((s) => (s.value === "current" ? { ...s, label: `This page (${current + 1})` } : s))}
                        />
                        {scope === "range" && (
                          <div>
                            <label htmlFor="crop-range" className="sr-only">
                              Pages to crop
                            </label>
                            <Input
                              id="crop-range"
                              value={rangeText}
                              onChange={(e) => {
                                setRangeText(e.target.value);
                                fail(null);
                              }}
                              placeholder="e.g. 2-4, 7"
                              autoComplete="off"
                              aria-invalid={!!(rangeText && picked.problem) || undefined}
                              aria-describedby="crop-range-note"
                              className="pointer-coarse:h-11"
                            />
                            <p
                              id="crop-range-note"
                              className={cn("mt-1.5 text-xs", rangeText && picked.problem ? "text-destructive" : "text-muted-foreground")}
                            >
                              {rangeText && picked.problem ? picked.problem : `${plural(count, "page")} picked`}
                            </p>
                          </div>
                        )}
                      </div>

                      <div className="border-t border-border pt-3">
                        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium sm:min-h-10">
                          <input
                            type="checkbox"
                            checked={remove}
                            onChange={(e) => setRemove(e.target.checked)}
                            aria-describedby="crop-remove-hint"
                            className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                          />
                          Remove what&apos;s outside the box
                        </label>
                        <p id="crop-remove-hint" className="pl-[30px] text-xs text-muted-foreground">
                          {remove
                            ? "The cropped pages become pictures of the area kept, so what was outside is gone for good. Links inside still work; comments and form fields become part of the picture."
                            : "Off: cropping hides what's outside the box, but it stays in the file and the right software can still find it."}
                        </p>
                        {remove && (
                          <div className="mt-3 grid gap-3 pl-[30px] sm:grid-cols-2">
                            <div>
                              <label htmlFor="crop-dpi" className="mb-1 block text-xs text-muted-foreground">
                                Picture quality
                              </label>
                              <select
                                id="crop-dpi"
                                value={dpi}
                                onChange={(e) => setDpi(e.target.value)}
                                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base pointer-coarse:h-11 sm:text-sm"
                              >
                                {DPI.map((d) => (
                                  <option key={d} value={d}>
                                    {d} DPI
                                  </option>
                                ))}
                              </select>
                            </div>
                            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm sm:mt-5 sm:min-h-10">
                              <input
                                type="checkbox"
                                checked={keepText}
                                onChange={(e) => setKeepText(e.target.checked)}
                                className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                              />
                              Keep text inside searchable
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  </fieldset>
                </motion.div>
              )}

              <AnimatePresence>
                {error && (
                  <InlineError
                    key="error"
                    shakeKey={errorKey}
                    message={<ErrorHelp message={error} slug={slug} files={source?.file ? [source.file] : failedFile ? [failedFile] : []} onLeave={nudge.cancel} />}
                  />
                )}
              </AnimatePresence>

              {source && (
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
                        <p aria-hidden className="mt-2 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                          <WorkingGlyph />
                          <span className="relative">
                            {progress?.label ?? "Casting…"}
                            <span className="absolute left-full top-0 ml-1.5">
                              <ProgressPercent value={progress?.fraction} />
                            </span>
                          </span>
                        </p>
                        <p className="sr-only" aria-live="polite">
                          {progress?.label ?? "Casting…"}
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
                        >
                          <Crop /> {actionLabel}
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

function UnitSelect({ unit, onChange }: { unit: Unit; onChange: (unit: Unit) => void }) {
  return (
    <div>
      <label htmlFor="crop-unit" className="mb-1 block text-xs text-muted-foreground">
        Unit
      </label>
      <select
        id="crop-unit"
        value={unit}
        onChange={(e) => onChange(e.target.value as Unit)}
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base pointer-coarse:h-11 sm:text-sm"
      >
        <option value="mm">mm</option>
        <option value="in">in</option>
        <option value="pt">pt</option>
      </select>
    </div>
  );
}

/** Previous, next, and a field to type a page number. */
function PageNav({
  current,
  pages,
  text,
  onText,
  onGo,
}: {
  current: number;
  pages: number;
  text: string;
  onText: (text: string) => void;
  onGo: (page: number) => void;
}) {
  if (pages < 2) return null;
  return (
    <div className="flex items-center justify-center gap-2 text-sm">
      <Button size="sm" variant="outline" className="pointer-coarse:h-11 pointer-coarse:w-11" onClick={() => onGo(current - 1)} disabled={current === 0} aria-label="Previous page">
        <ChevronLeft />
      </Button>
      <label htmlFor="crop-page" className="text-muted-foreground">
        Page
      </label>
      <Input
        id="crop-page"
        inputMode="numeric"
        autoComplete="off"
        value={text}
        onChange={(e) => onText(e.target.value)}
        onBlur={() => onText(String(current + 1))}
        className="h-9 w-16 text-center tabular-nums pointer-coarse:h-11"
      />
      <span className="tabular-nums text-muted-foreground">of {pages}</span>
      <Button size="sm" variant="outline" className="pointer-coarse:h-11 pointer-coarse:w-11" onClick={() => onGo(current + 1)} disabled={current >= pages - 1} aria-label="Next page">
        <ChevronRight />
      </Button>
    </div>
  );
}

const GRIP_PLACE: Record<Exclude<Grip, "move">, string> = {
  nw: "left-0 top-0 cursor-nwse-resize",
  n: "left-1/2 top-0 cursor-ns-resize",
  ne: "left-full top-0 cursor-nesw-resize",
  e: "left-full top-1/2 cursor-ew-resize",
  se: "left-full top-full cursor-nwse-resize",
  s: "left-1/2 top-full cursor-ns-resize",
  sw: "left-0 top-full cursor-nesw-resize",
  w: "left-0 top-1/2 cursor-ew-resize",
};

/** The preview is at most this tall: a phone keeps the fields in reach. */
const MAX_HEIGHT = 560;

/**
 * The page shown, drawn by pdf.js, with the box over it: what's outside is
 * dimmed. The box moves with a drag (mouse and pen), its handles resize it
 * (a finger too), a drag elsewhere on the page draws a new one (mouse and
 * pen: a finger on the page, in the box or out, scrolls it), and the arrow
 * keys work on it as on the editor's boxes.
 */
function CropPreview({
  loaded,
  page,
  size,
  box,
  editable,
  unit,
  onBox,
  onSay,
}: {
  loaded: LoadedPdf;
  page: number;
  size: Size | null;
  box: Box | null;
  editable: boolean;
  unit: Unit;
  onBox: (box: Box) => void;
  onSay: (message: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ grip: Grip | "draw"; start: Box | null; x: number; y: number; id: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const maxH = typeof window === "undefined" ? MAX_HEIGHT : Math.min(MAX_HEIGHT, Math.round(window.innerHeight * 0.65));
  const scale = size && width ? Math.min(width / size.width, maxH / size.height) : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scale) return;
    let live = true;
    setFailed(false);
    loaded.renderPage(page + 1, canvas, scale).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [loaded, page, scale]);

  // Let go of the page's pixels when the preview goes.
  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) canvas.width = canvas.height = 0;
    };
  }, []);

  // Read out where the box is once the keys stop.
  const [spoken, setSpoken] = useState<string | null>(null);
  useEffect(() => {
    if (spoken === null) return;
    const t = setTimeout(() => onSay(spoken), 500);
    return () => clearTimeout(t);
  }, [spoken, onSay]);

  const point = (e: React.PointerEvent) => {
    const r = wrap.current!.querySelector<HTMLElement>("[data-sheet]")!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  function grab(grip: Grip | "draw") {
    return (e: React.PointerEvent) => {
      if (!editable || !size || (e.pointerType === "mouse" && e.button !== 0)) return;
      // A finger on the page scrolls it, inside the box too (it covers most of
      // a phone's screen): only the handles take a finger. Mouse and pen also
      // move the box and draw a new one.
      if ((grip === "draw" || grip === "move") && e.pointerType === "touch") return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const p = point(e);
      drag.current = { grip, start: box, x: p.x, y: p.y, id: e.pointerId, moved: false };
    };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !size) return;
    const p = point(e);
    // A click without a drag draws nothing.
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) * scale < 4) return;
    d.moved = true;
    if (d.grip === "draw") onBox(boxBetween({ x: d.x, y: d.y }, p, size));
    else if (d.start) onBox(dragBox(d.start, d.grip, p.x - d.x, p.y - d.y, size));
  }

  function drop(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (d.moved && box) setSpoken(`Box: ${describeBox(box, unit)}.`);
  }

  function key(e: React.KeyboardEvent) {
    if (!size || !box) return;
    const next = nudgeBox(box, e, size);
    if (!next) return;
    e.preventDefault();
    onBox(next);
    setSpoken(`Box: ${describeBox(next, unit)}.`);
  }

  const w = size ? size.width * scale : 0;
  const h = size ? size.height * scale : 0;
  return (
    <div ref={wrap} className="flex w-full justify-center rounded-2xl border border-border bg-secondary/40 p-2 sm:p-3" data-testid="crop-preview">
      {size && scale > 0 ? (
        <div
          data-sheet
          className="relative select-none bg-white shadow-md ring-1 ring-black/10"
          style={{ width: w, height: h }}
          onPointerDown={grab("draw")}
          onPointerMove={move}
          onPointerUp={drop}
          onPointerCancel={drop}
        >
          <canvas ref={canvasRef} width={0} height={0} aria-hidden className="block !h-full !w-full" />
          {failed && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">This page couldn&apos;t be drawn.</p>}
          {/* The dimmed outside is the box's shadow, kept to the page. */}
          <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", editable && "cursor-crosshair")}>
            {box && (
              <div
                tabIndex={editable ? 0 : -1}
                role="group"
                aria-roledescription="crop box"
                aria-label={`Crop box on page ${page + 1}: ${describeBox(box, unit)}`}
                aria-describedby="crop-box-hint"
                aria-keyshortcuts={editable ? "ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowRight Alt+ArrowDown" : undefined}
                onKeyDown={editable ? key : undefined}
                onPointerDown={grab("move")}
                data-testid="crop-box"
                className={cn(
                  // An outline inside the box, not a ring: the box's shadow is the dimmed page round it, and the page clips it.
                  "absolute outline-none focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-[-6px] focus-visible:outline-ring",
                  editable ? "pointer-events-auto cursor-move border-2 border-primary" : "border-2 border-dashed border-primary"
                )}
                style={{
                  left: box.x * scale,
                  top: box.y * scale,
                  width: box.width * scale,
                  height: box.height * scale,
                  boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.45)",
                }}
              >
                {editable &&
                  GRIPS.map((grip) => (
                    <span
                      key={grip}
                      aria-hidden
                      onPointerDown={grab(grip)}
                      className={cn(
                        "absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center pointer-coarse:h-11 pointer-coarse:w-11",
                        GRIP_PLACE[grip]
                      )}
                    >
                      <span className="h-3 w-3 rounded-sm border-2 border-primary bg-background shadow" />
                    </span>
                  ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="mr-1.5 h-4 w-4 motion-safe:animate-spin" /> Drawing the page…
        </div>
      )}
    </div>
  );
}
