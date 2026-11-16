"use client";

import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  File as FileIcon,
  FilePlus2,
  Loader2,
  Pencil,
  RotateCcw,
  RotateCw,
  Sparkles,
  SquarePlus,
  Timer,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { friendlyPdfError } from "@/lib/pdf/errors";
import { DRAWN_AT_ONCE, NEAR_MARGIN, taskLimiter } from "@/lib/editor/thumbnails";
import { useHistory } from "@/lib/editor/history";
import type { LoadedPdf } from "@/lib/pdf/render";
import {
  appendSource,
  dropIndex,
  gridStep,
  idsBetween,
  insertBlank,
  moveItems,
  pageListText,
  parsePageList,
  planFor,
  removeItems,
  resultName,
  reverseItems,
  rotateItems,
  unchanged,
  type PagesMode,
  type PlanItem,
} from "@/lib/pdf/pages/plan";
import { cn, formatBytes } from "@/lib/utils";

/** Where each tool's result can go next. */
const NEXT_STEPS: Record<PagesMode, string[]> = {
  organize: ["compress-pdf", "page-numbers", "edit-pdf", "protect-pdf"],
  delete: ["compress-pdf", "organize-pdf", "page-numbers", "edit-pdf"],
  extract: ["merge-pdf", "compress-pdf", "organize-pdf", "edit-pdf"],
};

/** Thumbnails are drawn this many CSS pixels along their longer side. */
const THUMB_PX = 160;
/** A page's size until it has been measured: A4. */
const A4 = { width: 595, height: 842 };

type Status = "idle" | "reading" | "ready" | "working" | "done";
type Size = { width: number; height: number };
type Watch = (el: Element, onChange: (near: boolean) => void) => () => void;
type Slot = <T>(task: () => Promise<T>) => Promise<T>;

/** A chosen file and its pages, read by pdf.js for the thumbnails. */
interface Source {
  file: File;
  loaded: LoadedPdf;
  pages: number;
}

const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function readPdf(file: File): Promise<LoadedPdf> {
  const { loadForRender } = await import("@/lib/pdf/render");
  return loadForRender(new Uint8Array(await file.arrayBuffer()));
}

export function PageOrganizer({ mode, slug, tier }: { mode: PagesMode; slug: string; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const organize = mode === "organize";
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLInputElement>(null);

  const [sources, setSources] = useState<Source[]>([]);
  const history = useHistory<PlanItem[]>([]);
  const plan = history.state;
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** Where Shift-click and Shift+arrows extend the selection from. */
  const [anchor, setAnchor] = useState<string | null>(null);
  /** The page that takes Tab focus in the grid. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [rangeText, setRangeText] = useState("");
  const [rangeProblem, setRangeProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [result, setResult] = useState<{ blob: Blob; name: string; pages: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** The result has been downloaded at least once, so leaving doesn't lose it. */
  const [downloaded, setDownloaded] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  /** Read out after a page action. */
  const [note, setNote] = useState("");
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done" | "run" | "choose">();
  /** Holds the flow's height while the work view and the result swap. */
  const flow = useHeightLock<HTMLDivElement>();
  /** The running save; aborted on Cancel, on a new file and when the page goes away. */
  const job = useRef<AbortController | null>(null);
  /** Bumps for every file opened, so a slow read can't land after a newer one. */
  const opened = useRef(0);
  const gridRef = useRef<HTMLUListElement>(null);

  // pdf.js keeps each document (and its worker's memory) until destroyed.
  const sourcesRef = useRef<Source[]>([]);
  sourcesRef.current = sources;
  useEffect(
    () => () => {
      job.current?.abort();
      sourcesRef.current.forEach((s) => s.loaded.destroy());
    },
    []
  );

  // Undo can bring back pages or take them away: the selection follows.
  useEffect(() => {
    const live = new Set(plan.map((p) => p.id));
    setSelected((prev) => ([...prev].every((id) => live.has(id)) ? prev : new Set([...prev].filter((id) => live.has(id)))));
    setFocusId((id) => (id && live.has(id) ? id : (plan[0]?.id ?? null)));
  }, [plan]);

  function fail(message: string | null) {
    setError(message);
    if (message) setErrorKey((k) => k + 1);
  }

  function dropSources() {
    sourcesRef.current.forEach((s) => s.loaded.destroy());
    sourcesRef.current = [];
    setSources([]);
  }

  async function open(list: FileList | File[] | null) {
    if (!list?.length) return;
    const picked = Array.from(list).find(isPdf);
    if (!picked) {
      fail("Choose a PDF file.");
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
    dropSources();
    history.reset([]);
    setResult(null);
    fail(null);
    setStatus("reading");
    try {
      const loaded = await readPdf(picked);
      if (id !== opened.current) {
        loaded.destroy();
        return;
      }
      if (mode === "delete" && loaded.numPages < 2) {
        loaded.destroy();
        throw new Error("This PDF has only 1 page, so there's nothing to delete.");
      }
      setSources([{ file: picked, loaded, pages: loaded.numPages }]);
      const first = planFor(0, loaded.numPages);
      history.reset(first);
      setSelected(new Set());
      setAnchor(null);
      setFocusId(first[0]?.id ?? null);
      setRangeText("");
      setRangeProblem(null);
      setStatus("ready");
      // The first page takes focus, so arrow keys work straight away.
      if (hadFocus) requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>("[data-page]")?.focus());
    } catch (err) {
      if (id !== opened.current) return;
      fail(friendlyPdfError(err).message);
      if (hadFocus) focusNext.current = "choose";
      setStatus("idle");
    }
  }

  /** Organize: another PDF's pages, added at the end. */
  async function addMore(list: FileList | null) {
    const files = Array.from(list ?? []).filter(isPdf);
    if (!files.length) {
      if (list?.length) fail("Choose a PDF file.");
      return;
    }
    if (files.some((f) => f.size > limits.maxFileBytes)) {
      setUpsell("file-size");
      fail(`Files up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      return;
    }
    if (sources.length + files.length > limits.maxBatchFiles) {
      setUpsell("batch");
      fail(`Up to ${limits.maxBatchFiles} files at once on your plan.`);
      return;
    }
    const id = opened.current;
    setAdding(true);
    fail(null);
    const added: Source[] = [];
    let next = plan;
    try {
      for (const file of files) {
        const loaded = await readPdf(file).catch((err) => {
          throw friendlyPdfError(err, file.name);
        });
        if (id !== opened.current) {
          loaded.destroy();
          return;
        }
        added.push({ file, loaded, pages: loaded.numPages });
        next = appendSource(next, sources.length + added.length - 1, loaded.numPages);
      }
    } catch (err) {
      added.forEach((s) => s.loaded.destroy());
      fail(err instanceof Error ? err.message : "Couldn't add that file.");
      return;
    } finally {
      setAdding(false);
    }
    setSources([...sources, ...added]);
    history.commit(next);
    const count = added.reduce((n, s) => n + s.pages, 0);
    say(`Added ${plural(count, "page")} at the end.`);
    focusPage(next[plan.length]?.id);
  }

  function say(message: string) {
    // The same words twice in a row are still read out.
    setNote((prev) => (prev === message ? `${message} ` : message));
  }

  /** Moves keyboard focus to a page once the grid has caught up. */
  function focusPage(id: string | undefined) {
    if (!id) return;
    setFocusId(id);
    requestAnimationFrame(() =>
      gridRef.current?.querySelector<HTMLElement>(`[data-page="${CSS.escape(id)}"]`)?.focus({ preventScroll: false })
    );
  }

  function choose(next: ReadonlySet<string>) {
    setSelected(next);
    if (!organize) {
      setRangeText(pageListText(plan.filter((p) => next.has(p.id)).map((p) => (p.kind === "page" ? p.page : 0))));
      setRangeProblem(null);
    }
  }

  function typeRange(text: string) {
    fail(null);
    setRangeText(text);
    const { pages, problem } = parsePageList(text, plan.length);
    setRangeProblem(problem);
    setSelected(new Set(pages.map((i) => plan[i].id)));
    setAnchor(null);
  }

  /** Click or Space: pick or unpick a page. With Shift, everything from the last one picked. */
  function pick(id: string, range: boolean) {
    fail(null);
    if (range && anchor) {
      const next = new Set(selected);
      idsBetween(plan, anchor, id).forEach((x) => next.add(x));
      choose(next);
    } else {
      const next = new Set(selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      choose(next);
      setAnchor(id);
    }
    setFocusId(id);
  }

  /** The pages a page action works on: the picked ones, or the one it was asked on. */
  const targets = (id?: string): ReadonlySet<string> => (id && !selected.has(id) ? new Set([id]) : selected);

  function rotate(delta: number, id?: string) {
    const ids = targets(id);
    if (!ids.size) return;
    history.commit(rotateItems(plan, ids, delta));
    say(`${ids.size === 1 ? "Page" : plural(ids.size, "page")} turned ${delta > 0 ? "right" : "left"}.`);
  }

  function remove(id?: string) {
    const ids = targets(id);
    if (!ids.size) return;
    if (ids.size >= plan.length) {
      fail("A PDF needs at least one page.");
      return;
    }
    const first = plan.findIndex((p) => ids.has(p.id));
    const next = removeItems(plan, ids);
    history.commit(next);
    choose(new Set([...selected].filter((x) => !ids.has(x))));
    say(`${ids.size === 1 ? "Page" : plural(ids.size, "page")} deleted. Ctrl+Z brings ${ids.size === 1 ? "it" : "them"} back.`);
    if (gridRef.current?.contains(document.activeElement) || document.activeElement === document.body) {
      focusPage(next[Math.min(first, next.length - 1)]?.id);
    }
  }

  function move(delta: number, id?: string) {
    const ids = targets(id);
    if (!ids.size) return;
    const first = plan.findIndex((p) => ids.has(p.id));
    const next = moveItems(plan, ids, first + delta);
    if (next === plan) return;
    history.commit(next);
    const at = next.findIndex((p) => ids.has(p.id));
    say(`${ids.size === 1 ? "Page" : plural(ids.size, "page")} moved to position ${at + 1} of ${next.length}.`);
    if (id) focusPage(id);
  }

  async function addBlank() {
    // After the last page picked or the focused one, else at the end.
    const picked = plan.map((p, i) => (selected.has(p.id) ? i : -1)).filter((i) => i >= 0);
    const after = picked.length ? picked[picked.length - 1] : plan.length - 1;
    const ref = plan[after];
    let size: Size = A4;
    if (ref?.kind === "blank") size = { width: ref.width, height: ref.height };
    else if (ref) {
      // As the page is shown: its own turn (in the viewport) and the one added here.
      const vp = await sources[ref.source].loaded.getPageViewport(ref.page + 1, 1).catch(() => null);
      if (vp) size = ref.rotate % 180 ? { width: vp.height, height: vp.width } : { width: vp.width, height: vp.height };
    }
    const { plan: next, id } = insertBlank(plan, after, size);
    history.commit(next);
    say(`Blank page added at position ${after + 2}.`);
    focusPage(id);
  }

  function reverse() {
    history.commit(reverseItems(plan, selected));
    say(selected.size >= 2 ? "Picked pages reversed." : "Page order reversed.");
  }

  function undo() {
    if (!history.canUndo) return;
    history.undo();
    say("Undone.");
  }

  function dropOn(moving: ReadonlySet<string>, target: string) {
    const next = moveItems(plan, moving, dropIndex(plan, moving, target));
    if (next === plan) return;
    history.commit(next);
    const at = next.findIndex((p) => moving.has(p.id));
    say(`${moving.size === 1 ? "Page" : plural(moving.size, "page")} moved to position ${at + 1} of ${next.length}.`);
  }

  /** The pages that go into the new file. */
  function output(): PlanItem[] {
    if (organize) return plan;
    return plan.filter((p) => (mode === "delete" ? !selected.has(p.id) : selected.has(p.id)));
  }

  async function run() {
    if (!sources.length) return;
    if (rangeProblem) {
      fail(rangeProblem);
      return;
    }
    if (!organize && !selected.size) {
      fail(mode === "delete" ? "Pick the pages to delete." : "Pick the pages to extract.");
      return;
    }
    const pages = output();
    if (!pages.length) {
      fail("A PDF needs at least one page. To get rid of all of them, delete the file itself.");
      return;
    }
    if (organize && unchanged(pages, sources[0].pages)) {
      fail("Nothing has changed yet. Move, turn, add or delete a page first.");
      return;
    }
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "run";
    // Room for the result, reserved now while the click still explains it.
    flow.lock(resultFloor());
    setStatus("working");
    fail(null);
    setProgress(null);
    setNextFailed(null);
    const started = performance.now();
    const ctl = new AbortController();
    job.current = ctl;
    try {
      const { buildPagesFile } = await import("@/lib/pdf/pages/off-thread");
      const bytes = await buildPagesFile(
        sources.map((s) => s.file),
        pages,
        mode,
        (fraction, label) => !ctl.signal.aborted && setProgress({ fraction: Math.max(0, Math.min(1, fraction)), label }),
        ctl.signal
      );
      if (ctl.signal.aborted) return;
      const seconds = (performance.now() - started) / 1000;
      // Let the bar visibly finish before the result replaces it.
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      setResult({
        blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
        name: resultName(sources[0].file.name, mode, pages.map((p) => (p.kind === "page" ? p.page : 0))),
        pages: pages.length,
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
      // The work view stays, so nothing else lets go of the room kept for the result.
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
    dropSources();
    history.reset([]);
    setSelected(new Set());
    setRangeText("");
    setRangeProblem(null);
    setResult(null);
    fail(null);
    setStatus("idle");
  }

  /** Back from the result to the pages, as they were left. */
  function changePages() {
    nudge.cancel();
    flow.lock();
    setResult(null);
    setStatus("ready");
    requestAnimationFrame(() => focusPage(focusId ?? plan[0]?.id));
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

  /** Keys that work anywhere in the tool: undo and redo. */
  function onToolKey(e: React.KeyboardEvent) {
    if (!organize || status !== "ready" || !(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest("input")) return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      if (history.canRedo) {
        history.redo();
        say("Redone.");
      }
    }
  }

  const count = plan.length;
  const picked = selected.size;
  const working = status === "working";
  const multi = sources.length > 1;
  const summary = organize
    ? `${plural(count, "page")}${picked ? ` · ${picked} selected` : ""}`
    : mode === "delete"
      ? `${picked} to delete · ${count - picked} left`
      : `${picked} of ${plural(count, "page")} picked`;
  const actionLabel = organize
    ? "Save PDF"
    : mode === "delete"
      ? picked
        ? `Delete ${plural(picked, "page")}`
        : "Delete pages"
      : picked
        ? `Extract ${plural(picked, "page")}`
        : "Extract pages";

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {note}
      </p>
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }} onKeyDown={onToolKey}>
        <AnimatePresence mode="wait" initial={false}>
          {status === "done" && result ? (
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
                    {plural(result.pages, "page")} · {formatBytes(result.blob.size)}
                  </span>
                </>
              }
              actions={
                <>
                  <Button
                    onClick={() => {
                      nudge.downloaded();
                      setDownloaded(true);
                      downloadBlob(result.blob, result.name);
                    }}
                    size="lg"
                    className="min-w-44 shadow-lg shadow-primary/25"
                    data-testid="download"
                  >
                    <Download /> Download
                  </Button>
                  <Button onClick={changePages} variant="outline" size="lg">
                    <Pencil /> Change pages
                  </Button>
                  <Button onClick={reset} variant="ghost" size="lg">
                    <RotateCcw /> Start over
                  </Button>
                </>
              }
              next={{ slugs: NEXT_STEPS[mode], onPick: (next) => void continueWith(next), failed: nextFailed }}
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
              <input
                ref={addRef}
                type="file"
                accept="application/pdf,.pdf"
                multiple
                className="hidden"
                hidden
                aria-hidden
                tabIndex={-1}
                data-testid="add-input"
                onChange={(e) => {
                  addMore(e.target.files);
                  e.target.value = "";
                }}
              />

              {!sources.length ? (
                <ToolDropzone label="Drop a file here" onFiles={open}>
                  <p className="text-sm text-muted-foreground">or</p>
                  <Button ref={focusRef("choose")} className="mt-3 h-11" onClick={() => inputRef.current?.click()} disabled={status === "reading"}>
                    {status === "reading" ? <Loader2 className="motion-safe:animate-spin" /> : null}
                    {status === "reading" ? "Reading pages…" : "Choose file"}
                  </Button>
                  <p className="mt-4 text-xs text-muted-foreground">Stays on your device.</p>
                </ToolDropzone>
              ) : (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={ENTER.animate}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
                >
                  <FileIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{sources[0].file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(sources[0].file.size)} · {plural(sources[0].pages, "page")}
                      {multi && ` · and ${plural(sources.length - 1, "more file")}`}
                    </p>
                  </div>
                  {!working && (
                    <button
                      onClick={reset}
                      className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove ${sources[0].file.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </motion.div>
              )}

              {sources.length > 0 && (
                <motion.div initial={ENTER.initial} animate={ENTER.animate} className="space-y-3">
                  {/* Disabled as a whole while the file is written, without drawing every page again. */}
                  <fieldset disabled={working} className="min-w-0 space-y-3">
                    <legend className="sr-only">Pages</legend>
                    {organize ? (
                      <div className="space-y-2 rounded-2xl border border-border bg-card p-3">
                        <div className="flex flex-wrap gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => addRef.current?.click()} disabled={adding}>
                            {adding ? <Loader2 className="motion-safe:animate-spin" /> : <FilePlus2 />} Add PDF
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => void addBlank()}>
                            <SquarePlus /> Blank page
                          </Button>
                          <Button size="sm" variant="outline" onClick={reverse} disabled={count < 2}>
                            <ArrowDownUp /> Reverse
                          </Button>
                          <Button size="sm" variant="outline" onClick={undo} disabled={!history.canUndo} aria-keyshortcuts="Control+Z">
                            <Undo2 /> Undo
                          </Button>
                        </div>
                        <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                          <span className="text-sm tabular-nums text-muted-foreground" data-testid="page-count">
                            {summary}
                          </span>
                          {picked > 0 ? (
                            <Button size="sm" variant="ghost" onClick={() => choose(new Set())}>
                              Clear
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => choose(new Set(plan.map((p) => p.id)))}>
                              Select all
                            </Button>
                          )}
                        </div>
                        {picked > 0 && (
                          <div className="flex flex-wrap gap-1.5" data-testid="picked-actions">
                            <Button size="sm" variant="secondary" onClick={() => rotate(-90)} aria-label="Turn picked pages left">
                              <RotateCcw /> <span className="max-sm:sr-only">Left</span>
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => rotate(90)} aria-label="Turn picked pages right">
                              <RotateCw /> <span className="max-sm:sr-only">Right</span>
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => move(-1)} aria-label="Move picked pages earlier">
                              <ArrowLeft /> <span className="max-sm:sr-only">Earlier</span>
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => move(1)} aria-label="Move picked pages later">
                              <ArrowRight /> <span className="max-sm:sr-only">Later</span>
                            </Button>
                            <Button size="sm" variant="secondary" onClick={() => remove()} className="text-destructive" aria-label="Delete picked pages">
                              <Trash2 /> <span className="max-sm:sr-only">Delete</span>
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2 rounded-2xl border border-border bg-card p-3">
                        <label htmlFor="page-list" className="block text-sm font-medium">
                          {mode === "delete" ? "Pages to delete" : "Pages to extract"}
                        </label>
                        <Input
                          id="page-list"
                          value={rangeText}
                          onChange={(e) => typeRange(e.target.value)}
                          placeholder="e.g. 2-4, 7"
                          inputMode="text"
                          autoComplete="off"
                          aria-invalid={!!rangeProblem}
                          aria-describedby="page-list-note"
                        />
                        <div className="flex items-center justify-between gap-2">
                          <p
                            id="page-list-note"
                            className={cn("text-sm", rangeProblem ? "text-destructive" : "tabular-nums text-muted-foreground")}
                            data-testid="page-count"
                          >
                            {rangeProblem ?? summary}
                          </p>
                          {picked > 0 ? (
                            <Button size="sm" variant="ghost" onClick={() => choose(new Set())}>
                              Clear
                            </Button>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => choose(new Set(plan.map((p) => p.id)))}>
                              Select all
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    <PageGrid
                      gridRef={gridRef}
                      mode={mode}
                      plan={plan}
                      sources={sources}
                      selected={selected}
                      focusId={focusId}
                      multi={multi}
                      onPick={pick}
                      onFocusPage={setFocusId}
                      onKey={(e, i) => {
                        const item = plan[i];
                        const ctrl = e.ctrlKey || e.metaKey;
                        if (organize && e.altKey && /^Arrow/.test(e.key)) {
                          e.preventDefault();
                          const cols = gridColumns(gridRef.current);
                          move(e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : cols, item.id);
                          return;
                        }
                        const to = !ctrl && !e.altKey ? gridStep(i, e.key, plan.length, gridColumns(gridRef.current)) : null;
                        if (to !== null) {
                          e.preventDefault();
                          const target = plan[to].id;
                          if (e.shiftKey) {
                            const next = new Set(selected);
                            idsBetween(plan, anchor ?? item.id, target).forEach((x) => next.add(x));
                            if (!anchor) setAnchor(item.id);
                            choose(next);
                          }
                          focusPage(target);
                        } else if (e.key === " " && e.shiftKey) {
                          e.preventDefault();
                          pick(item.id, true);
                        } else if (ctrl && e.key.toLowerCase() === "a") {
                          e.preventDefault();
                          choose(new Set(plan.map((p) => p.id)));
                        } else if (e.key === "Escape" && picked) {
                          e.preventDefault();
                          choose(new Set());
                        } else if (organize && (e.key === "Delete" || e.key === "Backspace")) {
                          e.preventDefault();
                          remove(item.id);
                        }
                      }}
                      onRotate={(id) => rotate(90, id)}
                      onRemove={(id) => remove(id)}
                      onDrop={dropOn}
                    />
                  </fieldset>
                  <p id="page-grid-hint" className="text-center text-xs text-muted-foreground">
                    {organize ? (
                      <>
                        <span className="hover-none:hidden">
                          Drag pages to move them, or pick pages and use the buttons. Keys: arrows to move around, Space to pick, Alt +
                          arrows to move a page, Delete to remove it.
                        </span>
                        <span className="hidden hover-none:inline">Tap pages to pick them, then move, turn or delete them with the buttons.</span>
                      </>
                    ) : (
                      <>
                        Tap pages to pick them, or type page numbers above.
                        <span className="hover-none:hidden"> Shift-click picks a run of pages; arrows and Space work too.</span>
                      </>
                    )}
                  </p>
                </motion.div>
              )}

              <AnimatePresence>{error && <InlineError key="error" message={error} shakeKey={errorKey} />}</AnimatePresence>

              {sources.length > 0 && (
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
                      <motion.div
                        key="cast"
                        initial={{ opacity: 0, scale: 0.97 }}
                        animate={{ opacity: 1, scale: 1, transition: NOTICE_T }}
                        exit={HANDOFF.out}
                      >
                        <Button
                          ref={focusRef("run")}
                          size="lg"
                          onClick={run}
                          data-cast
                          data-testid="run"
                          variant={mode === "delete" && picked ? "destructive" : "default"}
                          className="min-w-52 shadow-lg shadow-primary/25"
                        >
                          {mode === "delete" ? <Trash2 /> : <Sparkles />} {actionLabel}
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
        <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo={`/tools/${slug}`} />
      )}
    </>
  );
}

/** How many pages fit in one row of the grid, read from where they sit. */
function gridColumns(grid: HTMLElement | null): number {
  const cells = grid ? Array.from(grid.children) as HTMLElement[] : [];
  if (!cells.length) return 1;
  const top = cells[0].offsetTop;
  const n = cells.findIndex((c) => c.offsetTop !== top);
  return n < 0 ? cells.length : n;
}

/** What the thumbnails draw with. Cells don't take it, so a new file redraws thumbnails, not cells. */
const Drawing = createContext<{ sources: Source[]; watch: Watch; slot: Slot } | null>(null);

/** The cells' handlers, the same for the life of the grid, so a cell is drawn again only when its own page changes. */
interface CellActions {
  pick(id: string, range: boolean): void;
  key(e: React.KeyboardEvent, index: number): void;
  focus(id: string): void;
  rotate(id: string): void;
  remove(id: string): void;
  dragStart(e: React.DragEvent, id: string): void;
  dragOver(e: React.DragEvent, id: string): void;
  dragLeave(id: string): void;
  drop(e: React.DragEvent, id: string): void;
  dragEnd(): void;
}

function PageGrid({
  gridRef,
  mode,
  plan,
  sources,
  selected,
  focusId,
  multi,
  onPick,
  onFocusPage,
  onKey,
  onRotate,
  onRemove,
  onDrop,
}: {
  gridRef: React.RefObject<HTMLUListElement | null>;
  mode: PagesMode;
  plan: PlanItem[];
  sources: Source[];
  selected: ReadonlySet<string>;
  focusId: string | null;
  multi: boolean;
  onPick: (id: string, range: boolean) => void;
  onFocusPage: (id: string) => void;
  onKey: (e: React.KeyboardEvent, index: number) => void;
  onRotate: (id: string) => void;
  onRemove: (id: string) => void;
  onDrop: (moving: ReadonlySet<string>, target: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const dragging = useRef<ReadonlySet<string> | null>(null);
  /** One observer for the grid: tells each thumbnail when it comes near the visible part. */
  const [watch] = useState<Watch>(() => {
    const listeners = new Map<Element, (near: boolean) => void>();
    let observer: IntersectionObserver | null = null;
    const watchOne: Watch = (el, onChange) => {
      if (typeof IntersectionObserver === "undefined") {
        onChange(true);
        return () => {};
      }
      observer ??= new IntersectionObserver((entries) => entries.forEach((e) => listeners.get(e.target)?.(e.isIntersecting)), {
        root: scroller.current,
        rootMargin: NEAR_MARGIN,
      });
      listeners.set(el, onChange);
      observer.observe(el);
      return () => {
        listeners.delete(el);
        observer?.unobserve(el);
      };
    };
    return watchOne;
  });
  const [slot] = useState<Slot>(() => taskLimiter(DRAWN_AT_ONCE));
  const drawing = useMemo(() => ({ sources, watch, slot }), [sources, watch, slot]);

  // A long document has hundreds of cells: their handlers read the latest props.
  const latest = useRef({ plan, selected, onPick, onFocusPage, onKey, onRotate, onRemove, onDrop });
  useLayoutEffect(() => {
    latest.current = { plan, selected, onPick, onFocusPage, onKey, onRotate, onRemove, onDrop };
  });
  const [actions] = useState<CellActions>(() => ({
    pick: (id, range) => latest.current.onPick(id, range),
    key: (e, i) => latest.current.onKey(e, i),
    focus: (id) => latest.current.onFocusPage(id),
    rotate: (id) => latest.current.onRotate(id),
    remove: (id) => latest.current.onRemove(id),
    dragStart: (e, id) => {
      const { selected } = latest.current;
      dragging.current = selected.has(id) ? selected : new Set([id]);
      e.dataTransfer.effectAllowed = "move";
      // Firefox starts a drag only with some data.
      e.dataTransfer.setData("text/plain", id);
    },
    dragOver: (e, id) => {
      if (!dragging.current) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(id);
    },
    dragLeave: (id) => setDragOver((d) => (d === id ? null : d)),
    drop: (e, id) => {
      if (!dragging.current) return;
      e.preventDefault();
      setDragOver(null);
      latest.current.onDrop(dragging.current, id);
      dragging.current = null;
    },
    dragEnd: () => {
      dragging.current = null;
      setDragOver(null);
    },
  }));

  const count = plan.length;
  return (
    <div
      ref={scroller}
      className="max-h-[min(36rem,70vh)] overflow-y-auto rounded-2xl border border-border bg-secondary/40 p-2 sm:p-3"
      data-testid="page-grid"
    >
      <Drawing.Provider value={drawing}>
        <ul ref={gridRef} aria-label="Pages" aria-describedby="page-grid-hint" className="grid grid-cols-2 gap-2 min-[400px]:grid-cols-3 sm:grid-cols-4 sm:gap-3">
          {plan.map((item, i) => (
            <PageCell
              key={item.id}
              item={item}
              index={i}
              count={count}
              mode={mode}
              selected={selected.has(item.id)}
              tabStop={focusId ? focusId === item.id : i === 0}
              dragOver={dragOver === item.id}
              from={multi && item.kind === "page" && item.source > 0 ? sources[item.source]?.file.name : undefined}
              actions={actions}
            />
          ))}
        </ul>
      </Drawing.Provider>
    </div>
  );
}

const PageCell = memo(function PageCell({
  item,
  index,
  count,
  mode,
  selected,
  tabStop,
  dragOver,
  from,
  actions,
}: {
  item: PlanItem;
  index: number;
  count: number;
  mode: PagesMode;
  selected: boolean;
  tabStop: boolean;
  dragOver: boolean;
  /** The file the page comes from, when there is more than one. */
  from?: string;
  actions: CellActions;
}) {
  const organize = mode === "organize";
  const what =
    item.kind === "blank"
      ? "blank page"
      : `${from ? `page ${item.page + 1} of ${from}` : mode === "organize" ? `was page ${item.page + 1}` : ""}`;
  const label = [`Page ${index + 1} of ${count}`, what, item.rotate ? `turned ${item.rotate}°` : ""].filter(Boolean).join(", ");
  const mark = mode === "delete" ? "To delete" : mode === "extract" ? "To extract" : "Selected";
  return (
    <li
      draggable={organize}
      onDragStart={organize ? (e) => actions.dragStart(e, item.id) : undefined}
      onDragOver={organize ? (e) => actions.dragOver(e, item.id) : undefined}
      onDragLeave={organize ? () => actions.dragLeave(item.id) : undefined}
      onDrop={organize ? (e) => actions.drop(e, item.id) : undefined}
      onDragEnd={organize ? actions.dragEnd : undefined}
      className="group relative"
      // Cells far out of view skip layout and paint.
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }}
    >
      <button
        type="button"
        data-page={item.id}
        tabIndex={tabStop ? 0 : -1}
        aria-pressed={selected}
        aria-label={label}
        aria-keyshortcuts={organize ? "Alt+ArrowLeft Alt+ArrowRight Delete" : undefined}
        onClick={(e) => actions.pick(item.id, e.shiftKey)}
        onKeyDown={(e) => actions.key(e, index)}
        onFocus={() => actions.focus(item.id)}
        className={cn(
          "block w-full rounded-xl border-2 bg-card p-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          selected
            ? mode === "delete"
              ? "border-destructive bg-destructive/5"
              : "border-primary bg-primary/5"
            : "border-transparent hover:border-border",
          dragOver && "border-dashed border-primary",
          organize && "cursor-grab active:cursor-grabbing"
        )}
      >
        <span className={cn("block", selected && mode === "delete" && "opacity-40")}>
          {item.kind === "blank" ? <BlankThumb item={item} /> : <PageThumb item={item} />}
        </span>
        <span className="mt-1 flex items-center gap-1 px-0.5 text-xs">
          <span className="font-medium tabular-nums">{index + 1}</span>
          {from && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{from}</span>}
        </span>
        {selected && (
          <span
            aria-hidden
            title={mark}
            className={cn(
              "absolute left-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full text-white shadow",
              mode === "delete" ? "bg-destructive" : "bg-primary"
            )}
          >
            {mode === "delete" ? <Trash2 className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
          </span>
        )}
      </button>
      {organize && (
        // Mouse shortcuts on a page; keyboard and touch use the buttons above the grid.
        <span className="absolute right-2.5 top-2.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 hover-none:hidden">
          <button
            type="button"
            tabIndex={-1}
            title={`Turn page ${index + 1} right`}
            aria-label={`Turn page ${index + 1} right`}
            onClick={() => actions.rotate(item.id)}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-foreground shadow hover:bg-accent"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            title={`Delete page ${index + 1}`}
            aria-label={`Delete page ${index + 1}`}
            onClick={() => actions.remove(item.id)}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-background/90 text-destructive shadow hover:bg-accent"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </span>
      )}
    </li>
  );
});

/**
 * A square that shows a page of `width` × `height` as large as fits, turned
 * `rotate` degrees. The longer side fills the square either way round, so
 * turning a page never changes the cell's size.
 */
function Frame({ width, height, rotate, children }: Size & { rotate: number; children: React.ReactNode }) {
  const max = Math.max(width, height) || 1;
  return (
    <span className="relative block aspect-square w-full">
      <span
        className="absolute left-1/2 top-1/2 block overflow-hidden rounded border border-border bg-white shadow-sm"
        style={{ width: `${(width / max) * 100}%`, height: `${(height / max) * 100}%`, transform: `translate(-50%, -50%) rotate(${rotate}deg)` }}
      >
        {children}
      </span>
    </span>
  );
}

function BlankThumb({ item }: { item: Extract<PlanItem, { kind: "blank" }> }) {
  return (
    <Frame width={item.width} height={item.height} rotate={item.rotate}>
      <span className="flex h-full items-center justify-center text-[11px] text-muted-foreground">Blank</span>
    </Frame>
  );
}

/** Lets go of a canvas's pixels now, not when it is collected. */
function release(canvas: HTMLCanvasElement) {
  canvas.width = canvas.height = 0;
}

/**
 * A page drawn only while near the visible part of the grid, a few at a time
 * (`slot`). Far away it lets go of its pixels and keeps its size.
 */
function PageThumb({ item }: { item: Extract<PlanItem, { kind: "page" }> }) {
  const { sources, watch, slot } = useContext(Drawing)!;
  const loaded = sources[item.source]?.loaded;
  const box = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLCanvasElement>(null);
  const nearRef = useRef(false);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!box.current) return;
    return watch(box.current, (v) => {
      nearRef.current = v;
      setNear(v);
    });
  }, [watch]);

  useEffect(() => {
    const canvas = ref.current;
    if (!near || !canvas || !loaded) return;
    let current = true;
    slot(async () => {
      if (!current) return;
      const vp = await loaded.getPageViewport(item.page + 1, 1);
      if (!current) return;
      setSize({ width: vp.width, height: vp.height });
      await loaded.renderPage(item.page + 1, canvas, THUMB_PX / Math.max(vp.width, vp.height, 1));
      // Scrolled away while it was drawn.
      if (!nearRef.current) release(canvas);
    }).catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [near, loaded, item.page, slot]);

  useEffect(() => {
    if (!near && ref.current) release(ref.current);
  }, [near]);

  const shown = size ?? A4;
  return (
    <span ref={box} className="block">
      <Frame width={shown.width} height={shown.height} rotate={item.rotate}>
        {failed ? (
          <span className="flex h-full items-center justify-center text-xs text-muted-foreground">—</span>
        ) : (
          <canvas ref={ref} width={0} height={0} className="block !h-full !w-full" />
        )}
      </Frame>
    </span>
  );
}
