"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Info,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldCheck,
  SquarePlus,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, scrollBehavior, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { isPdf, readPdf } from "./read-pdf";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { friendlyPdfError } from "@/lib/pdf/errors";
import { isAbort } from "@/lib/abort";
import { ErrorHelp } from "./ErrorHelp";
import { takesMessage } from "./file-pick";
import { getTool } from "@/lib/tools";
import type { LoadedPdf } from "@/lib/pdf/render";
import type { RedactReport } from "@/lib/pdf/redact/index";
import {
  HANDLES,
  MIN_BOX,
  PRESETS,
  addFound,
  describeRect,
  dragRect,
  findOnPage,
  markId,
  markLabel,
  nudgeRect,
  planNeedles,
  queryPattern,
  rectBetween,
  redactedName,
  startRect,
  wordsUnder,
  type Copy,
  type Handle,
  type Mark,
  type PageText,
  type PresetId,
  type Rect,
} from "@/lib/pdf/redact/marks";
import { cn, formatBytes } from "@/lib/utils";

/** Where a redacted PDF can go next. */
const NEXT_STEPS = ["protect-pdf", "compress-pdf", "merge-pdf", "page-numbers"];

type Status = "idle" | "reading" | "ready" | "working" | "done";

interface Source {
  file: File;
  loaded: LoadedPdf;
  pages: number;
}

interface Size {
  width: number;
  height: number;
}

interface Result {
  blob: Blob;
  name: string;
  report: RedactReport;
  /** Pages where copies were left unmarked on purpose. */
  left: number[];
}

const DPI = ["100", "150", "200", "300"];

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** "1", "1 and 3", "1, 3 and 4". */
function listPages(pages: number[]): string {
  const p = [...new Set(pages)].sort((a, b) => a - b).map((n) => String(n + 1));
  if (p.length < 2) return p.join("");
  return `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}`;
}

/** Copies of marked text no mark covers, a line per text: what someone should decide about before redacting. */
function copyLines(copies: Copy[]): { text: string; pages: number[]; hidden: number[]; count: number }[] {
  const byText = new Map<string, { text: string; pages: number[]; hidden: number[]; count: number }>();
  for (const c of copies) {
    const line = byText.get(c.text) ?? { text: c.text, pages: [], hidden: [], count: 0 };
    line.pages.push(c.page);
    if (c.hidden) line.hidden.push(c.page);
    line.count++;
    byText.set(c.text, line);
  }
  return [...byText.values()];
}

/** Where a line's copies are, saying which no reader shows: “on page 2, outside the visible area (a crop hides it)”. */
function copyPlaces(line: { pages: number[]; hidden: number[] }): string {
  const many = new Set(line.pages).size > 1;
  const where = `on ${many ? "pages" : "page"} ${listPages(line.pages)}`;
  if (!line.hidden.length) return where;
  if (line.hidden.length === line.pages.length) return `${where}, outside the visible area (a crop hides it)`;
  return `${where} (on ${new Set(line.hidden).size > 1 ? "pages" : "page"} ${listPages(line.hidden)} outside the visible area)`;
}

/** What a finished job also took out, in words. */
function removedText(r: RedactReport): string {
  const parts = ["the document's details (title, author and the like)"];
  if (r.annotations) parts.push(plural(r.annotations, "comment or link", "comments and links"));
  if (r.fields) parts.push(plural(r.fields, "form field"));
  if (r.bookmarks) parts.push(`${plural(r.bookmarks, "bookmark title")} naming redacted text`);
  if (r.attachments) parts.push("attached files");
  if (r.scripts) parts.push("scripts");
  return `${parts.slice(0, -1).join(", ")}${parts.length > 1 ? " and " : ""}${parts[parts.length - 1]}`;
}

export function RedactTool({ slug, tier }: { slug: string; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const inputRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<Source | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  /** The page shown, 0-indexed, and its size as shown. */
  const [current, setCurrent] = useState(0);
  const [pageInput, setPageInput] = useState("1");
  const [view, setView] = useState<Size | null>(null);
  const [marks, setMarksState] = useState<Mark[]>([]);
  /** The marks as they are now, for work that finishes after other changes (two searches at once). */
  const marksRef = useRef<Mark[]>([]);
  const setMarks = (next: Mark[] | ((list: Mark[]) => Mark[])) => {
    marksRef.current = typeof next === "function" ? next(marksRef.current) : next;
    setMarksState(marksRef.current);
  };
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  /** What the last search or preset did, shown under them and read out. */
  const [found, setFound] = useState("");
  /** Reading the text of every page for a search: how far. */
  const [reading, setReading] = useState<{ fraction: number; label: string } | null>(null);
  const [dpi, setDpi] = useState("150");
  const [keepText, setKeepText] = useState(true);
  /** Copies of marked text found unmarked when Redact was pressed: they need a choice. */
  const [copies, setCopies] = useState<Copy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [failedFile, setFailedFile] = useState<File | null>(null);
  /** Bumps when page text arrives, so labels that use it are worked out again. */
  const [, setTextVersion] = useState(0);
  const reduce = useReducedMotion();
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done" | "run" | "choose" | "file" | "copies" | "drop" | "keep" | `remove:${string}`>();
  const findRef = useRef<HTMLInputElement>(null);
  /** Asking before the file and its marks are thrown away. */
  const [confirmDrop, setConfirmDrop] = useState(false);
  const flow = useHeightLock<HTMLDivElement>();
  /** The running job; aborted on Cancel, on a new file and when the page goes away. */
  const job = useRef<AbortController | null>(null);
  /** Reading text for a search; aborted with the file. */
  const textJob = useRef<AbortController | null>(null);
  const opened = useRef(0);
  /** Each page's text once read: for searching, for what a box covers, and for the check. */
  const texts = useRef(new Map<number, PageText>());
  /** The page shown's text, read on its own as it is shown: what shows only, for the words under a box. */
  const shown = useRef(new Map<number, PageText>());
  /** The file with its boxes made very large, to read the text a crop hides: made once a search or Redact needs it. */
  const wide = useRef<Promise<LoadedPdf | null> | null>(null);
  /** A mark to focus once its page is shown. */
  const focusMark = useRef<string | null>(null);

  const sourceRef = useRef<Source | null>(null);
  sourceRef.current = source;
  useEffect(
    () => () => {
      job.current?.abort();
      textJob.current?.abort();
      sourceRef.current?.loaded.destroy();
      void wide.current?.then((w) => w?.destroy());
    },
    []
  );

  // The size of the page shown, and its text, for the words under a box.
  useEffect(() => {
    if (!source) return;
    let live = true;
    source.loaded
      .getPageViewport(current + 1, 1)
      .then((vp) => live && setView({ width: vp.width, height: vp.height }))
      .catch((err) => live && fail(friendlyPdfError(err).message));
    if (!texts.current.has(current) && !shown.current.has(current)) {
      source.loaded
        .pageText(current + 1)
        .then((t) => {
          if (!live || sourceRef.current !== source) return;
          shown.current.set(current, t);
          setTextVersion((v) => v + 1);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [source, current]);

  function fail(message: string | null) {
    setError(message);
    if (message) setErrorKey((k) => k + 1);
  }

  function say(message: string) {
    setNote((prev) => (prev === message ? `${message} ` : message));
  }

  function dropSource() {
    textJob.current?.abort();
    textJob.current = null;
    reading$.current = null;
    sourceRef.current?.loaded.destroy();
    sourceRef.current = null;
    void wide.current?.then((w) => w?.destroy());
    wide.current = null;
    texts.current = new Map();
    shown.current = new Map();
    setSource(null);
    setReading(null);
    setConfirmDrop(false);
  }

  function getWide(): Promise<LoadedPdf | null> {
    const from = sourceRef.current;
    if (!from) return Promise.resolve(null);
    wide.current ??= import("@/lib/pdf/redact/run")
      .then(({ openWide }) => openWide(from.file))
      .then((w) => {
        // The file was closed meanwhile.
        if (sourceRef.current !== from) {
          w?.destroy();
          return null;
        }
        return w;
      })
      .catch(() => null);
    return wide.current;
  }

  /** Marks fit their text: the pages they are on are read again with each letter where the font puts it. */
  async function placeOn(pages: Map<number, PageText>, which: number[], opts: { signal?: AbortSignal; progress?: (fraction: number, label: string) => void } = {}) {
    const from = sourceRef.current;
    const todo = which.filter((p) => !pages.get(p)?.exact);
    if (!from || !todo.length) return;
    const { placeExactly } = await import("@/lib/pdf/redact/run");
    await placeExactly(from.loaded, pages, todo, { wide: await getWide(), ...opts });
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
      setSource({ file: picked, loaded, pages: loaded.numPages });
      setCurrent(0);
      setPageInput("1");
      setView({ width: first.width, height: first.height });
      setMarks([]);
      setSelected(null);
      setCopies(null);
      setFound("");
      setStatus("ready");
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

  /** The text of every page, read once; a long file shows how far it has got. A second search waits for the same reading. */
  const reading$ = useRef<Promise<Map<number, PageText> | null> | null>(null);
  function allText(): Promise<Map<number, PageText> | null> {
    if (!source) return Promise.resolve(null);
    if (texts.current.size >= source.pages) return Promise.resolve(texts.current);
    if (reading$.current) return reading$.current;
    const ctl = new AbortController();
    textJob.current = ctl;
    // Assigned before its finally runs: that is always after an await.
    let pending!: Promise<Map<number, PageText> | null>;
    pending = (async () => {
      try {
        const { readText } = await import("@/lib/pdf/redact/run");
        if (source.pages > 20) setReading({ fraction: 0, label: "Reading the file…" });
        const out = await readText(source.loaded, {
          have: texts.current,
          wide: await getWide(),
          signal: ctl.signal,
          progress: (fraction, label) => source.pages > 20 && !ctl.signal.aborted && setReading({ fraction, label }),
        });
        setTextVersion((v) => v + 1);
        return out;
      } catch (err) {
        if (!isAbort(err) && !ctl.signal.aborted) fail(friendlyPdfError(err).message);
        return null;
      } finally {
        if (textJob.current === ctl) {
          textJob.current = null;
          setReading(null);
        }
        if (reading$.current === pending) reading$.current = null;
      }
    })();
    reading$.current = pending;
    return pending;
  }

  /** Marks every match of `pattern` on every page, beside the marks there are. */
  async function markAll(pattern: RegExp, kind: Mark["kind"], whole: boolean, valid: ((s: string) => boolean) | undefined, what: { none: string; some: (n: number, pages: number) => string }) {
    fail(null);
    setCopies(null);
    const from = source;
    const pages = await allText();
    if (!pages || sourceRef.current !== from) return;
    // The pages with matches are read again so the marks fit their letters.
    const hits = [...pages].filter(([, text]) => findOnPage(text, pattern, valid).length).map(([page]) => page);
    const ctl = new AbortController();
    textJob.current = ctl;
    try {
      await placeOn(pages, hits, { signal: ctl.signal, progress: (fraction, label) => hits.length > 20 && !ctl.signal.aborted && setReading({ fraction, label }) });
    } catch (err) {
      if (!isAbort(err) && !ctl.signal.aborted) fail(friendlyPdfError(err).message);
      return;
    } finally {
      if (textJob.current === ctl) {
        textJob.current = null;
        setReading(null);
      }
    }
    if (sourceRef.current !== from) return;
    const added: Mark[] = [];
    const all = [...marksRef.current];
    for (const [page, text] of [...pages].sort((a, b) => a[0] - b[0])) {
      const fresh = addFound(all, page, findOnPage(text, pattern, valid), kind, whole);
      all.push(...fresh);
      added.push(...fresh);
    }
    setMarks(all);
    const onPages = new Set(added.map((m) => m.page));
    const message = added.length ? what.some(added.length, onPages.size) : what.none;
    setFound(message);
    say(message);
    // The first new mark is shown, unless one is already on the page shown.
    if (added.length && !added.some((m) => m.page === current)) goTo(added[0].page);
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    const pattern = queryPattern(query, { matchCase, wholeWord });
    if (!pattern) {
      fail("Type the text to find first.");
      return;
    }
    const q = query.trim();
    void markAll(pattern, "search", wholeWord, undefined, {
      none: `No matches for “${q}”.`,
      some: (n, p) => `Marked ${plural(n, "match", "matches")} for “${q}” on ${plural(p, "page")}.`,
    });
  }

  function preset(id: PresetId) {
    const p = PRESETS.find((x) => x.id === id)!;
    void markAll(p.pattern, id, true, p.valid, {
      none: `No ${p.plural} found.`,
      some: (n, pages) => `Marked ${n} ${n === 1 ? p.plural.replace(/s$/, "") : p.plural} on ${plural(pages, "page")}.`,
    });
  }

  function goTo(page: number) {
    if (!source) return;
    const to = Math.max(0, Math.min(source.pages - 1, page));
    setCurrent(to);
    setPageInput(String(to + 1));
  }

  /** A box mark's text is the words under it, worked out again when it moves. */
  function boxText(page: number, rects: Rect[]) {
    const t = texts.current.get(page) ?? shown.current.get(page);
    return t ? wordsUnder(t, rects) : "";
  }

  function addBox(rect: Rect, page = current) {
    const mark: Mark = { id: markId(), page, rects: [rect], kind: "box", text: boxText(page, [rect]), whole: true, on: true };
    setMarks((m) => [...m, mark]);
    setSelected(mark.id);
    setCopies(null);
    fail(null);
    return mark;
  }

  function moveBox(id: string, rect: Rect) {
    setMarks((list) => list.map((m) => (m.id === id ? { ...m, rects: [rect], text: boxText(m.page, [rect]) } : m)));
    setCopies(null);
  }

  function removeMark(id: string, focusAfter: "list" | "page") {
    const index = marks.findIndex((m) => m.id === id);
    const gone = marks[index];
    setMarks((list) => list.filter((m) => m.id !== id));
    if (selected === id) setSelected(null);
    setCopies(null);
    if (gone) say(`${markLabel(gone)} removed.`);
    // Focus goes to the next mark in the same place, so a keyboard user isn't dropped to the top.
    if (focusAfter === "page") {
      const next = marks.find((m, i) => i !== index && m.page === gone?.page);
      if (next) focusMark.current = next.id;
    } else {
      // In the list: the next row's Remove, else the one before, else Find.
      const at = sorted.findIndex((m) => m.id === id);
      const next = sorted[at + 1] ?? sorted[at - 1];
      if (next) focusNext.current = `remove:${next.id}`;
      else focusFind();
    }
  }

  /** Back to Find once the list is empty: it is far above by then, so it is brought into view. */
  function focusFind() {
    const el = findRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }

  function toggleMark(id: string, on: boolean) {
    setMarks((list) => list.map((m) => (m.id === id ? { ...m, on } : m)));
    setCopies(null);
  }

  function showMark(mark: Mark) {
    goTo(mark.page);
    setSelected(mark.id);
    focusMark.current = mark.id;
  }

  function clearMarks() {
    setMarks([]);
    setSelected(null);
    setCopies(null);
    setFound("");
    say("All marks removed.");
    focusFind();
  }

  const ticked = marks.filter((m) => m.on);

  /** `copies`: what to do with unmarked copies of marked text, once asked. */
  /** Too many pages to rebuild on this plan: said, with the upgrade, before any work. */
  function overLimit(list: Mark[]): boolean {
    const n = new Set(list.filter((m) => m.on).map((m) => m.page)).size;
    if (n <= limits.redactPages) return false;
    setUpsell("redact-pages");
    fail(`${plural(n, "page has", "pages have")} marks. Redact PDF rebuilds up to ${plural(limits.redactPages, "page")} at once on your plan: untick some, or redact the file in parts.`);
    return true;
  }

  async function run(choice?: "mark" | "leave") {
    if (!source) return;
    if (!ticked.length) return fail(marks.length ? "Tick at least one mark to redact." : "Mark something to redact first: draw a box, search, or pick what to find.");
    if (overLimit(ticked)) return;
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "run";
    const wasCopies = !!document.activeElement?.closest("[data-copies]");
    flow.lock(resultFloor());
    setStatus("working");
    fail(null);
    setProgress(null);
    setNextFailed(null);
    const started = performance.now();
    const ctl = new AbortController();
    job.current = ctl;
    try {
      // Every page's text: copies elsewhere are found, and the check after knows what to look for.
      const { readText, redactDocument, RedactionLeakError } = await import("@/lib/pdf/redact/run");
      setProgress({ fraction: 0, label: "Reading the file…" });
      const pages = await readText(source.loaded, {
        have: texts.current,
        wide: await getWide(),
        signal: ctl.signal,
        progress: (fraction, label) => !ctl.signal.aborted && setProgress({ fraction: fraction * 0.1, label }),
      });
      let list = marksRef.current;
      let plan = planNeedles(pages, list);
      // Copies the person may mark too are placed by the font's widths first.
      const loose = plan.copies.filter((c) => !c.hidden && !pages.get(c.page)?.exact).map((c) => c.page);
      if (loose.length) {
        await placeOn(pages, loose, { signal: ctl.signal });
        plan = planNeedles(pages, list);
      }
      if (plan.copies.length && !choice) {
        // Decided by the person, not guessed: back to the marks with the copies listed.
        setCopies(plan.copies);
        focusNext.current = "copies";
        flow.release();
        setStatus("ready");
        return;
      }
      if (plan.copies.length && choice === "mark") {
        const extra: Mark[] = [];
        for (const c of plan.copies) {
          const origin = list.find((m) => m.on && m.text.trim().toLowerCase() === c.text.trim().toLowerCase());
          extra.push(...addFound([...list, ...extra], c.page, [{ text: c.text, rects: c.rects, hidden: c.hidden, note: c.note }], "search", origin?.whole ?? true));
        }
        list = [...list, ...extra];
        setMarks(list);
        if (overLimit(list)) {
          setCopies(null);
          flow.release();
          setStatus("ready");
          return;
        }
        plan = planNeedles(pages, list);
      }
      // Copies are left only when the person said so; otherwise none may stay.
      if (choice !== "leave") for (const n of plan.needles) n.allowed = {};
      setCopies(null);
      const done = await redactDocument(
        source.file,
        { marks: list, needles: plan.needles, dpi: Number(dpi), keepText },
        {
          loaded: source.loaded,
          progress: (fraction, label) => !ctl.signal.aborted && setProgress({ fraction: 0.1 + fraction * 0.9, label }),
          signal: ctl.signal,
        }
      ).catch((err) => {
        if (err instanceof RedactionLeakError) throw new Error(err.message);
        throw err;
      });
      if (ctl.signal.aborted) return;
      const seconds = (performance.now() - started) / 1000;
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      setResult({
        blob: new Blob([done.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
        name: redactedName(source.file.name),
        report: done.report,
        left: choice === "leave" ? [...new Set(plan.copies.map((c) => c.page))] : [],
      });
      setDownloaded(false);
      setElapsed(seconds);
      if (wasCopies || focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "done";
      }
      settleSlot(flow.ref.current);
      setStatus("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch (err) {
      if (ctl.signal.aborted || isAbort(err)) return;
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
    setMarks([]);
    setCopies(null);
    fail(null);
    setStatus("idle");
  }

  /** Back from the result to the marks, as they were left. */
  function changeMarks() {
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
  const here = marks.filter((m) => m.page === current);
  const onPages = new Set(ticked.map((m) => m.page)).size;
  const sorted = [...marks].sort((a, b) => a.page - b.page || a.rects[0].y0 - b.rects[0].y0 || a.rects[0].x0 - b.rects[0].x0);

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
                    {plural(result.report.areas, "area")} on {plural(result.report.pages, "page")} · {formatBytes(result.blob.size)}
                  </span>
                  <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-emerald-100 px-2.5 py-1 text-left font-medium text-emerald-800" data-testid="redact-checked">
                    <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" />
                    {/* Copies left on purpose are still in the file: the check can only promise what was marked. */}
                    {result.left.length > 0 ? "Checked: what you marked is gone from the new file." : "Checked: the redacted text isn't anywhere in the new file."}{" "}
                    {result.report.pages === 1 ? "The page with marks is now a picture" : "The pages with marks are now pictures"} with the marks painted black. Also removed:{" "}
                    {removedText(result.report)}.
                  </span>
                  {result.left.length > 0 && (
                    <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-left font-medium text-amber-800">
                      <Info className="mt-0.5 h-3 w-3 shrink-0" />
                      Copies you chose to leave are still on {result.left.length === 1 ? "page" : "pages"} {listPages(result.left)}.
                    </span>
                  )}
                </>
              }
              actions={
                <>
                  <Button onClick={saveResult} size="lg" className="min-w-44 shadow-lg shadow-primary/25" data-testid="download">
                    <Download /> Download
                  </Button>
                  <Button onClick={changeMarks} variant="outline" size="lg">
                    <Pencil /> Change marks
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
                  data-testid="redact-file"
                >
                  <FileIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{source.file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatBytes(source.file.size)} · {plural(source.pages, "page")}
                    </p>
                  </div>
                  {!working && !confirmDrop && (
                    <button
                      ref={focusRef("drop")}
                      onClick={() => {
                        // Marks take work to make: one click doesn't throw them away.
                        if (!marks.length) return reset();
                        setConfirmDrop(true);
                        focusNext.current = "keep";
                      }}
                      className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove ${source.file.name}`}
                      data-testid="redact-drop"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </motion.div>
              )}

              {source && confirmDrop && !working && (
                <div role="group" aria-labelledby="redact-drop-q" className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-sm" data-testid="redact-drop-confirm">
                  <p id="redact-drop-q" className="mr-auto">
                    Remove the file and its {plural(marks.length, "mark")}?
                  </p>
                  <Button ref={focusRef("keep")} type="button" variant="outline" size="sm" className="pointer-coarse:h-11" onClick={() => {
                    setConfirmDrop(false);
                    focusNext.current = "drop";
                  }}>
                    Keep them
                  </Button>
                  <Button type="button" variant="destructive" size="sm" className="pointer-coarse:h-11" onClick={reset} data-testid="redact-drop-yes">
                    Remove
                  </Button>
                </div>
              )}

              {!source && (
                <p className="flex items-start gap-2 rounded-xl bg-secondary/60 px-4 py-3 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    A black box drawn in an ordinary PDF editor only covers words: they can still be copied out of the file. Here, each page
                    with a mark is rebuilt as a picture with the marks painted black, so what was under them is gone, and the file is checked
                    before you can download it.
                  </span>
                </p>
              )}

              {source && (
                <motion.div initial={ENTER.initial} animate={ENTER.animate}>
                  <fieldset disabled={working} className="min-w-0 space-y-4">
                    <legend className="sr-only">Redact</legend>

                    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
                      <form onSubmit={search} className="space-y-2" role="search" aria-label="Find text to redact">
                        <label htmlFor="redact-find" className="block text-sm font-medium">
                          Find text
                        </label>
                        <div className="flex gap-2">
                          <Input
                            ref={findRef}
                            id="redact-find"
                            value={query}
                            onChange={(e) => {
                              setQuery(e.target.value);
                              fail(null);
                            }}
                            placeholder="A name, a number, a word"
                            autoComplete="off"
                            enterKeyHint="search"
                            className="min-w-0 flex-1 pointer-coarse:h-11"
                          />
                          <Button type="submit" variant="outline" className="shrink-0 pointer-coarse:h-11" disabled={!!reading} data-testid="mark-matches">
                            Mark all
                          </Button>
                        </div>
                        <div className="flex flex-wrap gap-x-5 gap-y-1">
                          {(
                            [
                              ["Match case", matchCase, setMatchCase],
                              ["Whole words", wholeWord, setWholeWord],
                            ] as const
                          ).map(([label, value, set]) => (
                            <label key={label} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-9">
                              <input
                                type="checkbox"
                                checked={value}
                                onChange={(e) => set(e.target.checked)}
                                className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                              />
                              {label}
                            </label>
                          ))}
                        </div>
                      </form>
                      <fieldset className="min-w-0 border-t border-border pt-3">
                        <legend className="mb-1.5 pt-3 text-sm font-medium">Find and mark every</legend>
                        <div className="flex flex-wrap gap-1.5">
                          {PRESETS.map((p) => (
                            <Button
                              key={p.id}
                              type="button"
                              size="sm"
                              variant="outline"
                              className="rounded-full pointer-coarse:h-11"
                              onClick={() => preset(p.id)}
                              disabled={!!reading}
                              data-testid={`preset-${p.id}`}
                            >
                              {p.label}
                            </Button>
                          ))}
                        </div>
                      </fieldset>
                      {(reading || found) && (
                        <p className="text-xs text-muted-foreground" data-testid="redact-found">
                          {reading ? (
                            <span className="inline-flex items-center gap-1.5">
                              <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden /> {reading.label} {Math.round(reading.fraction * 100)}%
                            </span>
                          ) : (
                            found
                          )}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <PageNav
                        current={current}
                        pages={source.pages}
                        text={pageInput}
                        onText={(t) => {
                          setPageInput(t);
                          const n = Number(t);
                          if (Number.isInteger(n) && n >= 1 && n <= source.pages) setCurrent(n - 1);
                        }}
                        onGo={goTo}
                      />
                      <RedactPreview
                        loaded={source.loaded}
                        page={current}
                        size={view}
                        marks={here}
                        selected={selected}
                        editable={!working}
                        focusMark={focusMark}
                        onSelect={setSelected}
                        onDraw={(r) => {
                          const m = addBox(r);
                          say(`Box added: ${describeRect(r)}.`);
                          focusMark.current = m.id;
                        }}
                        onMove={moveBox}
                        onRemove={(id) => removeMark(id, "page")}
                        onSay={say}
                      />
                      <div className="flex flex-col items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="pointer-coarse:h-11"
                          disabled={!view}
                          data-testid="add-box"
                          onClick={() => {
                            if (!view) return;
                            const r = startRect(view.width, view.height);
                            const m = addBox(r);
                            focusMark.current = m.id;
                            say(`Box added in the middle of page ${current + 1}. Arrows move it, Alt and arrows resize it.`);
                          }}
                        >
                          <SquarePlus /> Add a box
                        </Button>
                        <p id="redact-box-hint" className="text-center text-xs text-muted-foreground">
                          <span className="hover-none:hidden">
                            Drag on the page to draw a box. On a box: arrows move it, Alt + arrows resize it, Shift moves 10 times further, Delete
                            removes it.
                          </span>
                          <span className="hidden hover-none:inline">Add a box, then drag it or its handles over what to hide.</span>
                        </p>
                      </div>
                    </div>

                    <section className="space-y-2 rounded-2xl border border-border bg-card p-4" aria-labelledby="redact-marks">
                      <div className="flex items-center justify-between gap-2">
                        <h2 id="redact-marks" className="text-sm font-medium">
                          Marks {marks.length > 0 && <span className="text-muted-foreground">({ticked.length === marks.length ? marks.length : `${ticked.length} of ${marks.length} ticked`})</span>}
                        </h2>
                        {marks.length > 0 && (
                          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground pointer-coarse:h-11" onClick={clearMarks}>
                            <Trash2 /> Remove all
                          </Button>
                        )}
                      </div>
                      {marks.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Nothing marked yet. Draw a box, find text, or pick what to find above.</p>
                      ) : (
                        <ul className="max-h-72 space-y-1 overflow-y-auto pr-1" data-testid="redact-list">
                          {sorted.map((m) => (
                            <li key={m.id} className={cn("flex items-center gap-1 rounded-lg pl-1.5", selected === m.id && "bg-accent")}>
                              <input
                                type="checkbox"
                                checked={m.on}
                                onChange={(e) => toggleMark(m.id, e.target.checked)}
                                aria-label={`Redact ${markLabel(m)}, page ${m.page + 1}`}
                                className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                              />
                              {/* The mark's name shows it on its page: one button less on a narrow screen. */}
                              <button
                                type="button"
                                onClick={() => showMark(m)}
                                aria-label={`Show ${markLabel(m)}, page ${m.page + 1}`}
                                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
                              >
                                <span className={cn("min-w-0 flex-1 truncate", !m.on && "text-muted-foreground line-through")}>{markLabel(m)}</span>
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">p. {m.page + 1}</span>
                                <Eye className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                              </button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-9 w-9 shrink-0 p-0 text-muted-foreground pointer-coarse:h-11 pointer-coarse:w-11"
                                ref={focusRef(`remove:${m.id}`)}
                                aria-label={`Remove ${markLabel(m)}, page ${m.page + 1}`}
                                onClick={() => removeMark(m.id, "list")}
                              >
                                <X />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>

                    <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2">
                      <div>
                        <label htmlFor="redact-dpi" className="mb-1 block text-sm font-medium">
                          Picture quality
                        </label>
                        <select
                          id="redact-dpi"
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
                      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm sm:mt-6 sm:min-h-10">
                        <input
                          type="checkbox"
                          checked={keepText}
                          onChange={(e) => setKeepText(e.target.checked)}
                          className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                        />
                        Keep the other words searchable
                      </label>
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        Pages with a mark become pictures with the marks painted black; pages without marks stay as they are.
                        {keepText ? " The words not under a mark, or right next to one, stay searchable on those pages." : " Their words won't be searchable."}
                      </p>
                    </div>
                  </fieldset>
                </motion.div>
              )}

              <AnimatePresence>
                {copies && copies.length > 0 && !working && (
                  <motion.div
                    key="copies"
                    ref={focusRef("copies")}
                    tabIndex={-1}
                    data-copies
                    initial={ENTER.initial}
                    animate={ENTER.animate}
                    exit={FADE_EXIT}
                    className="space-y-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
                    role="group"
                    aria-labelledby="redact-copies"
                    data-testid="redact-copies"
                  >
                    <p id="redact-copies" className="font-medium">
                      Some marked text is also somewhere you haven&apos;t marked.
                    </p>
                    <ul className="list-disc space-y-1 pl-5">
                      {copyLines(copies)
                        .slice(0, 5)
                        .map((c) => (
                          <li key={c.text}>
                            “{c.text.length > 48 ? `${c.text.slice(0, 47)}…` : c.text}”: {c.count === 1 ? "once" : `${c.count} times`}, {copyPlaces(c)}
                          </li>
                        ))}
                    </ul>
                    {copyLines(copies).length > 5 && <p>And {copyLines(copies).length - 5} more.</p>}
                    {copies.some((c) => c.hidden) && <p>Marking text outside the visible area rebuilds its page from what shows, which leaves it out.</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" onClick={() => void run("mark")} data-testid="mark-copies">
                        Mark them too and redact
                      </Button>
                      <Button type="button" variant="outline" onClick={() => void run("leave")} data-testid="leave-copies">
                        Leave them and redact
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

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
                        <Button ref={focusRef("run")} size="lg" onClick={() => void run()} data-cast data-testid="run" className="min-w-52 shadow-lg shadow-primary/25">
                          <EyeOff /> {ticked.length ? `Redact ${plural(onPages, "page")}` : "Redact PDF"}
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
      <label htmlFor="redact-page" className="text-muted-foreground">
        Page
      </label>
      <Input
        id="redact-page"
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

const HANDLE_PLACE: Record<Exclude<Handle, "move">, string> = {
  nw: "left-0 top-0 cursor-nwse-resize",
  n: "left-1/2 top-0 cursor-ns-resize",
  ne: "left-full top-0 cursor-nesw-resize",
  e: "left-full top-1/2 cursor-ew-resize",
  se: "left-full top-full cursor-nwse-resize",
  s: "left-1/2 top-full cursor-ns-resize",
  sw: "left-0 top-full cursor-nesw-resize",
  w: "left-0 top-1/2 cursor-ew-resize",
};

/** The preview is at most this tall: big enough to place a box on a line, while a phone keeps the list in reach. */
const MAX_HEIGHT = 900;

/**
 * The page shown, drawn by pdf.js, with its marks over it: ticked ones dark,
 * as they will be painted, others dashed. A drag on the page draws a box
 * (mouse and pen; a finger scrolls, and uses Add a box and the handles). A
 * box moves with a drag (a finger too) and its handles resize it; every mark
 * takes focus, and the keys work on boxes as on Crop PDF's box.
 */
function RedactPreview({
  loaded,
  page,
  size,
  marks,
  selected,
  editable,
  focusMark,
  onSelect,
  onDraw,
  onMove,
  onRemove,
  onSay,
}: {
  loaded: LoadedPdf;
  page: number;
  size: Size | null;
  marks: Mark[];
  selected: string | null;
  editable: boolean;
  focusMark: React.MutableRefObject<string | null>;
  onSelect: (id: string | null) => void;
  onDraw: (rect: Rect) => void;
  onMove: (id: string, rect: Rect) => void;
  onRemove: (id: string) => void;
  onSay: (message: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  /** A box being drawn, before it is a mark. */
  const [drawing, setDrawing] = useState<Rect | null>(null);
  const drag = useRef<{ handle: Handle | "draw"; id: string | null; start: Rect | null; x: number; y: number; pointer: number; moved: boolean } | null>(null);
  const els = useRef(new Map<string, HTMLElement>());

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const maxH = typeof window === "undefined" ? MAX_HEIGHT : Math.min(MAX_HEIGHT, Math.round(window.innerHeight * 0.8));
  // The wrapper's padding and border: the sheet fits inside them.
  const inner = Math.max(0, width - (width < 640 ? 18 : 26));
  const scale = size && inner ? Math.min(inner / size.width, maxH / size.height) : 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !scale) return;
    let live = true;
    setFailed(false);
    // Comments and fields too: they go from a redacted page, so what they show is what gets painted over.
    loaded.renderPage(page + 1, canvas, scale, { forms: true }).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [loaded, page, scale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) canvas.width = canvas.height = 0;
    };
  }, []);

  // A mark asked to be shown gets focus once it is on screen.
  useEffect(() => {
    const id = focusMark.current;
    if (!id) return;
    const el = els.current.get(id);
    if (el) {
      focusMark.current = null;
      el.focus({ preventScroll: false });
      el.scrollIntoView?.({ block: "nearest" });
    }
  });

  // Read out where a box is once the keys stop.
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

  function grab(handle: Handle | "draw", mark?: Mark) {
    return (e: React.PointerEvent) => {
      if (!editable || !size || (e.pointerType === "mouse" && e.button !== 0)) return;
      // A finger on the page scrolls it; boxes and their handles take a finger.
      if (handle === "draw" && e.pointerType === "touch") return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      if (mark) onSelect(mark.id);
      const p = point(e);
      drag.current = { handle, id: mark?.id ?? null, start: mark?.rects[0] ?? null, x: p.x, y: p.y, pointer: e.pointerId, moved: false };
    };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !size) return;
    const p = point(e);
    if (!d.moved && Math.hypot(p.x - d.x, p.y - d.y) * scale < 4) return;
    d.moved = true;
    if (d.handle === "draw") setDrawing(rectBetween({ x: d.x, y: d.y }, p, size.width, size.height));
    else if (d.start && d.id) onMove(d.id, dragRect(d.start, d.handle, p.x - d.x, p.y - d.y, size.width, size.height));
  }

  function drop(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    if (d.handle === "draw") {
      const r = drawing;
      setDrawing(null);
      if (d.moved && r && r.x1 - r.x0 >= MIN_BOX && r.y1 - r.y0 >= MIN_BOX) onDraw(r);
      else if (!d.moved) onSelect(null);
      return;
    }
    const m = marks.find((x) => x.id === d.id);
    if (d.moved && m) setSpoken(`Box: ${describeRect(m.rects[0])}.`);
  }

  function key(mark: Mark) {
    return (e: React.KeyboardEvent) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onRemove(mark.id);
        return;
      }
      if (!editable || !size || mark.kind !== "box") return;
      const next = nudgeRect(mark.rects[0], e, size.width, size.height);
      if (!next) return;
      e.preventDefault();
      onMove(mark.id, next);
      setSpoken(`Box: ${describeRect(next)}.`);
    };
  }

  const w = size ? size.width * scale : 0;
  const h = size ? size.height * scale : 0;
  return (
    <div ref={wrap} className="flex w-full justify-center rounded-2xl border border-border bg-secondary/40 p-2 sm:p-3" data-testid="redact-preview">
      {size && scale > 0 ? (
        <div
          data-sheet
          className={cn("relative select-none overflow-hidden bg-white shadow-md ring-1 ring-black/10", editable && "cursor-crosshair")}
          style={{ width: w, height: h }}
          onPointerDown={grab("draw")}
          onPointerMove={move}
          onPointerUp={drop}
          onPointerCancel={drop}
        >
          <canvas ref={canvasRef} width={0} height={0} aria-hidden className="block !h-full !w-full" />
          {failed && <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">This page couldn&apos;t be drawn.</p>}
          {marks.map((m) => {
            const box = m.kind === "box";
            const isSelected = selected === m.id;
            return m.rects.map((r, i) => (
              <div
                key={`${m.id}-${i}`}
                ref={
                  i === 0
                    ? (el) => {
                        if (el) els.current.set(m.id, el);
                        else els.current.delete(m.id);
                      }
                    : undefined
                }
                tabIndex={i === 0 ? 0 : -1}
                role="group"
                aria-roledescription={box ? "redaction box" : "redaction mark"}
                aria-label={`${markLabel(m)}${m.on ? "" : ", not ticked"}${box ? `: ${describeRect(r)}` : ""}`}
                aria-describedby="redact-box-hint"
                aria-keyshortcuts={box ? "ArrowLeft ArrowRight ArrowUp ArrowDown Alt+ArrowRight Alt+ArrowDown Delete" : "Delete"}
                onKeyDown={key(m)}
                onFocus={() => onSelect(m.id)}
                onPointerDown={box ? grab("move", m) : (e) => (e.stopPropagation(), onSelect(m.id))}
                data-testid={box ? "redact-box" : "redact-mark"}
                className={cn(
                  "absolute outline-none focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-ring",
                  m.on ? "bg-slate-950/80" : "border-2 border-dashed border-slate-500 bg-transparent",
                  isSelected && "ring-2 ring-primary ring-offset-1",
                  box && editable && "cursor-move touch-none"
                )}
                style={{ left: r.x0 * scale, top: r.y0 * scale, width: Math.max(2, (r.x1 - r.x0) * scale), height: Math.max(2, (r.y1 - r.y0) * scale) }}
              >
                {box &&
                  editable &&
                  isSelected &&
                  HANDLES.filter((handle) => {
                    // On a thin box the side handles would cover its middle, where a finger grabs it to move it: the corners resize it.
                    if (handle === "n" || handle === "s") return (r.y1 - r.y0) * scale >= 56;
                    if (handle === "e" || handle === "w") return (r.x1 - r.x0) * scale >= 56;
                    return true;
                  }).map((handle) => (
                    <span
                      key={handle}
                      aria-hidden
                      onPointerDown={grab(handle, m)}
                      className={cn(
                        "absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center pointer-coarse:h-11 pointer-coarse:w-11",
                        HANDLE_PLACE[handle]
                      )}
                    >
                      <span className="h-3 w-3 rounded-sm border-2 border-primary bg-background shadow" />
                    </span>
                  ))}
              </div>
            ));
          })}
          {drawing && (
            <div
              aria-hidden
              className="pointer-events-none absolute border-2 border-primary bg-slate-950/60"
              style={{ left: drawing.x0 * scale, top: drawing.y0 * scale, width: (drawing.x1 - drawing.x0) * scale, height: (drawing.y1 - drawing.y0) * scale }}
            />
          )}
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
        </div>
      )}
    </div>
  );
}
