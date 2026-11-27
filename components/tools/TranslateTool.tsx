"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Download, File as FileIcon, FileText, Info, Languages, RotateCcw, ShieldCheck, Timer, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { ErrorHelp } from "./ErrorHelp";
import { isPdf } from "./read-pdf";
import { emptyMessage, takesMessage } from "./file-pick";
import { AUTO, LanguagePicker } from "./LanguagePicker";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { friendlyPdfError, SCANNED_MESSAGE } from "@/lib/pdf/errors";
import { isAbort } from "@/lib/abort";
import { getTool } from "@/lib/tools";
import { docxOnlyReason, languageByCode, pdfSupported, type Language } from "@/lib/translate/languages";
import { applyTranslation, chargeForSegments, pagesText, planTranslation, type Segment, type TranslationPlan } from "@/lib/translate/segments";
import { TranslateError, translateSegments } from "@/lib/translate/client";
import type { TranslateStatus } from "@/lib/translate/format";
import type { Block, ParsedDocument } from "@/lib/pdf/parse";
import { cn, formatBytes } from "@/lib/utils";

/** Where the translated PDF can go next. */
const NEXT_STEPS = ["compress-pdf", "edit-pdf", "sign-pdf", "merge-pdf"];

type Status = "idle" | "reading" | "ready" | "translating" | "writing" | "done";

interface Loaded {
  file: File;
  parsed: ParsedDocument;
  plan: TranslationPlan;
}

/**
 * Translations already paid for, by passage, for one file into one
 * language. After Cancel or a failure the next run sends only the rest.
 */
interface Kept {
  key: string;
  map: Map<string, string>;
}

/** What the last run that didn't finish left behind, said on the page. */
interface Stopped {
  key: string;
  /** Stopped with Cancel, or by a failure (the error says which). */
  cancelled: boolean;
  done: number;
  total: number;
  /** Characters of today's allowance it took, once known. */
  used: number | null;
}

interface Result {
  lang: Language;
  docx: { name: string; blob: Blob };
  pdf?: { name: string; blob: Blob };
  missing: Segment[];
  /** Letters the PDF font left out. */
  note?: string;
  elapsed: number;
  /** The first blocks, to read before downloading. */
  preview: Block[];
}

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;
const chars = (n: number) => n.toLocaleString("en-US");
const keyOf = (file: File, target: string, source: string) => `${file.name}|${file.size}|${file.lastModified}|${target}|${source}`;

/** The file's name without .pdf, then the language: "report-fr.docx". */
function outputName(name: string, lang: Language, ext: string) {
  const base = name.replace(/\.pdf$/i, "") || "document";
  return `${base}-${lang.code}.${ext}`;
}

export function TranslateTool({ slug, tier }: { slug: string; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const limits = limitsFor(tier);
  const input = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  const [status, setStatus] = useState<Status>("idle");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState<{ page: number; total: number } | null>(null);
  const [target, setTarget] = useState("");
  const [source, setSource] = useState(AUTO);
  const [service, setService] = useState<TranslateStatus | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [writing, setWriting] = useState<{ fraction: number; label: string } | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<{ message: string; login?: boolean } | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [failedFile, setFailedFile] = useState<File | null>(null);
  const [targetMissing, setTargetMissing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [kept, setKept] = useState<Kept | null>(null);
  const [stopped, setStopped] = useState<Stopped | null>(null);
  /** Characters left before the run, to say what a stopped one took. */
  const before = useRef<number | null>(null);
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"choose" | "reading" | "file" | "target" | "run" | "progress" | "done">();
  const flow = useHeightLock<HTMLDivElement>();
  /** The running read or translation; aborted on Cancel, on a new file and when the page goes away. */
  const job = useRef<AbortController | null>(null);
  const targetRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => job.current?.abort(), []);

  // Whether translation runs here, and what is left today.
  function refreshService(): Promise<TranslateStatus | null> {
    return fetch("/api/ai/translate", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TranslateStatus | null) => {
        if (d) setService(d);
        return d;
      })
      .catch(() => null);
  }
  useEffect(() => void refreshService(), []);

  /**
   * Says on the page what a run that didn't finish left: the passages kept,
   * and, once the server has given back what never came, what it took.
   */
  function noteStop(key: string, cancelled: boolean, done: number, total: number) {
    setStopped({ key, cancelled, done, total, used: null });
    const was = before.current;
    // The server gives back what a stopped request didn't deliver once it sees the request end.
    window.setTimeout(() => {
      void refreshService().then((d) => {
        if (was == null || d?.remaining == null) return;
        setStopped((s) => (s && s.key === key ? { ...s, used: Math.max(0, was - d.remaining!) } : s));
      });
    }, 800);
  }

  // A file handed over from the homepage or another tool.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => handed[0] && open([handoffToFile(handed[0])]))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fail(message: string | null, file: File | null = null, login = false) {
    setError(message ? { message, login } : null);
    setFailedFile(file);
    if (message) setErrorKey((k) => k + 1);
  }

  function say(message: string) {
    setNote((prev) => (prev === message ? `${message} ` : message));
  }

  async function open(list: FileList | File[] | null) {
    if (!list?.length) return;
    const file = Array.from(list).find(isPdf);
    if (!file) {
      fail(takesMessage(getTool(slug)?.name, "application/pdf", false));
      return;
    }
    const empty = emptyMessage([file]);
    if (empty) {
      fail(empty);
      return;
    }
    // Limits are an upgrade prompt, never a silent failure.
    if (file.size > limits.maxFileBytes) {
      setUpsell("file-size");
      fail(`${file.name} is over ${formatLimitBytes(limits.maxFileBytes)}, the limit on your plan.`);
      return;
    }
    job.current?.abort();
    const ctl = new AbortController();
    job.current = ctl;
    const hadFocus = !!flow.ref.current?.contains(document.activeElement);
    fail(null);
    setResult(null);
    setLoaded(null);
    setKept(null);
    setStopped(null);
    setReading(null);
    // Cancel stays in reach while a long file is read.
    if (hadFocus) focusNext.current = "reading";
    setStatus("reading");
    try {
      const { parseDocument } = await import("@/lib/pdf/parse");
      const parsed = await parseDocument(
        new Uint8Array(await file.arrayBuffer()),
        (page, total) => !ctl.signal.aborted && setReading({ page, total }),
        ctl.signal,
        { scans: true }
      );
      if (ctl.signal.aborted) return;
      const plan = planTranslation(parsed);
      if (parsed.likelyScanned || !plan.segments.length) {
        fail(parsed.likelyScanned ? `${file.name}: ${SCANNED_MESSAGE}` : `${file.name}: there's no text in it to translate.`, file);
        if (hadFocus) focusNext.current = "choose";
        setStatus("idle");
        return;
      }
      setLoaded({ file, parsed, plan });
      setStatus("ready");
      if (hadFocus) focusNext.current = target ? "run" : "target";
      say(`${file.name}: ${plural(parsed.pageCount, "page")}, ${chars(plan.chars)} characters to translate.`);
    } catch (err) {
      if (ctl.signal.aborted || isAbort(err)) return;
      fail(friendlyPdfError(err, file.name).message, file);
      if (hadFocus) focusNext.current = "choose";
      setStatus("idle");
    } finally {
      if (job.current === ctl) {
        job.current = null;
        setReading(null);
      }
    }
  }

  async function translate() {
    if (!loaded) return;
    const lang = languageByCode(target);
    if (!lang) {
      setTargetMissing(true);
      fail("Choose the language to translate into.");
      targetRef.current?.focus();
      return;
    }
    if (service && !service.available) {
      fail("Translation isn't available right now. Please try again later.");
      return;
    }
    const key = keyOf(loaded.file, lang.code, source);
    const keep = kept?.key === key ? kept : { key, map: new Map<string, string>() };
    const charge = chargeForSegments(loaded.plan.segments.filter((s) => !keep.map.has(s.id)));
    if (service?.remaining != null && charge > service.remaining) {
      // The note under the languages already says so; for Free and guests the upgrade prompt is the next step.
      if (upgradable) setUpsell("translate-size");
      say(overMessage(charge, service.remaining));
      return;
    }
    setKept(keep);
    setStopped(null);
    before.current = service?.remaining ?? null;
    // Cancel stays in reach while it works; the result or the error takes focus after.
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "progress";
    flow.lock(resultFloor());
    fail(null);
    setProgress({ done: loaded.plan.segments.filter((s) => keep.map.has(s.id)).length, total: loaded.plan.segments.length });
    setWriting(null);
    setWaiting(0);
    setNextFailed(null);
    setStatus("translating");
    const started = performance.now();
    const ctl = new AbortController();
    job.current = ctl;
    // Passages arrive one by one, thousands in a long file: the count is
    // shown at most ten times a second, not re-rendered for each.
    let latest: { done: number; total: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const showProgress = (done: number, total: number) => {
      latest = { done, total };
      timer ??= setTimeout(() => {
        timer = undefined;
        if (!ctl.signal.aborted && latest) setProgress(latest);
      }, 100);
    };
    try {
      const { translations, missing } = await translateSegments(loaded.plan.segments, {
        target: lang.code,
        source,
        signal: ctl.signal,
        onProgress: showProgress,
        onWait: (seconds) => !ctl.signal.aborted && setWaiting(seconds),
        kept: keep.map,
      });
      clearTimeout(timer);
      if (ctl.signal.aborted) return;
      setProgress({ done: translations.size, total: loaded.plan.segments.length });
      if (missing.length === loaded.plan.segments.length) throw new TranslateError("Nothing came back from the translation service. Please try again.");
      setWaiting(0);
      setStatus("writing");
      const done = applyTranslation(loaded.parsed, loaded.plan, translations, lang.noSpaces ? "" : " ");
      const { writeTranslation } = await import("@/lib/pdf/translate/off-thread");
      const title = `${loaded.file.name.replace(/\.pdf$/i, "")} (${lang.name})`;
      const files = await writeTranslation(
        { doc: done.doc, title, lang: lang.code, rtl: !!lang.rtl, pdf: pdfSupported(lang), name: loaded.file.name },
        (fraction, label) => !ctl.signal.aborted && setWriting({ fraction, label }),
        ctl.signal
      );
      if (ctl.signal.aborted) return;
      setWriting((w) => ({ fraction: 1, label: w?.label ?? "Saving" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      setResult({
        lang,
        docx: { name: outputName(loaded.file.name, lang, "docx"), blob: new Blob([files.docx as Uint8Array<ArrayBuffer>], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }) },
        pdf: files.pdf ? { name: outputName(loaded.file.name, lang, "pdf"), blob: new Blob([files.pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) } : undefined,
        missing: done.missing,
        note: files.note,
        elapsed: (performance.now() - started) / 1000,
        preview: done.doc.blocks.slice(0, 12),
      });
      setDownloaded(false);
      if (focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "done";
      }
      settleSlot(flow.ref.current);
      setStatus("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
      void refreshService();
    } catch (err) {
      if (ctl.signal.aborted || isAbort(err)) return;
      if (err instanceof TranslateError) {
        // Only the day's allowance running out by use gets the upgrade
        // prompt; a failure ("failed") or a busy service doesn't.
        if (err.reason === "translate" && err.upgrade) setUpsell("translate");
        fail(err.message, null, err.status === 401);
      } else {
        fail(friendlyPdfError(err).message, loaded.file);
      }
      // What was translated before it stopped is kept for the next try.
      setKept({ ...keep });
      noteStop(key, false, loaded.plan.segments.filter((s) => keep.map.has(s.id)).length, loaded.plan.segments.length);
      if (focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "run";
      }
      flow.release();
      setStatus("ready");
    } finally {
      clearTimeout(timer);
      if (job.current === ctl) {
        job.current = null;
        setProgress(null);
        setWaiting(0);
      }
    }
  }

  function cancel() {
    const running = status === "translating" || status === "writing";
    job.current?.abort();
    job.current = null;
    setProgress(null);
    setWriting(null);
    setWaiting(0);
    focusNext.current = loaded ? "run" : "choose";
    flow.release();
    setStatus(loaded ? "ready" : "idle");
    if (running && loaded && kept) {
      const done = loaded.plan.segments.filter((s) => kept.map.has(s.id)).length;
      setKept({ ...kept });
      noteStop(kept.key, true, done, loaded.plan.segments.length);
      say(`Stopped after ${chars(done)} of ${plural(loaded.plan.segments.length, "passage")}. ${done ? "They're kept, so translating again sends only the rest." : ""}`);
    } else say("Stopped.");
  }

  function reset() {
    job.current?.abort();
    nudge.cancel();
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "choose";
    if (status === "done") flow.lock();
    else flow.release();
    setLoaded(null);
    setResult(null);
    setKept(null);
    setStopped(null);
    fail(null);
    setStatus("idle");
  }

  /** Back to the file, to translate it into another language. */
  function anotherLanguage() {
    nudge.cancel();
    flow.lock();
    setResult(null);
    focusNext.current = "target";
    setStatus("ready");
  }

  function save(d: { name: string; blob: Blob }) {
    nudge.downloaded();
    setDownloaded(true);
    downloadBlob(d.blob, d.name);
  }

  /** Takes the file to another tool, already chosen there. */
  async function openIn(nextSlug: string, file: Blob, name: string) {
    nudge.cancel();
    setNextFailed(null);
    if (await tryHandoff([fileToHandoff(file, name)])) router.push(`/tools/${nextSlug}?handoff=1`);
    else setNextFailed(nextSlug);
  }

  const lang = languageByCode(target);
  const working = status === "translating" || status === "writing";
  // Guests and Free can upgrade for more; Pro and Team have the most there is.
  const upgradable = tier === "guest" || tier === "free";
  const key = loaded && lang ? keyOf(loaded.file, lang.code, source) : null;
  const keptMap = key && kept?.key === key ? kept.map : null;
  const keptDone = loaded && keptMap ? loaded.plan.segments.filter((s) => keptMap.has(s.id)).length : 0;
  const total = loaded?.plan.segments.length ?? 0;
  const charge = loaded ? chargeForSegments(keptMap ? loaded.plan.segments.filter((s) => !keptMap.has(s.id)) : loaded.plan.segments) : 0;
  const over = !!loaded && service?.remaining != null && charge > service.remaining;
  const partial = keptDone > 0 && keptDone < total;
  const scans = loaded?.parsed.scans ?? [];

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {note}
      </p>
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
        <AnimatePresence mode="wait" initial={false}>
          {status === "done" && result ? (
            <motion.div key="done" className="flex flex-1 flex-col gap-6" exit={{ opacity: 0, transition: { duration: 0.15 } }}>
              <SuccessCard
                className="flex-1"
                title={`Translated into ${result.lang.name}`}
                titleRef={focusRef("done")}
                files={[result.docx, ...(result.pdf ? [result.pdf] : [])].map((f) => ({ name: f.name, size: f.blob.size, onDownload: () => save(f) }))}
                stats={
                  <>
                    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                      <Timer className="h-3 w-3" /> {result.elapsed < 60 ? `${result.elapsed.toFixed(1)} s` : `${Math.floor(result.elapsed / 60)} min ${Math.round(result.elapsed % 60)} s`}
                    </span>
                    {loaded && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                        {plural(loaded.plan.segments.length - result.missing.length, "passage")} translated
                      </span>
                    )}
                    {result.missing.length > 0 && (
                      <Notice>
                        {plural(result.missing.length, "passage")} couldn&apos;t be translated and {result.missing.length === 1 ? "stays" : "stay"} in the original language, in place ({pagesText(result.missing.map((m) => m.page))}).
                      </Notice>
                    )}
                    {scans.length > 0 && <Notice>{scansNote(scans)} Not translated: run OCR PDF first to include {scans.length === 1 ? "it" : "them"}.</Notice>}
                    {result.note && <Notice>PDF: {result.note}</Notice>}
                    {!result.pdf && <Notice>{docxOnlyReason(result.lang)}</Notice>}
                  </>
                }
                actions={
                  <div className="flex w-full flex-col items-center justify-center gap-3 sm:flex-row sm:flex-wrap">
                    <Button onClick={() => save(result.docx)} size="lg" className="min-w-44 shadow-lg shadow-primary/25" data-testid="download">
                      <Download /> Download Word
                    </Button>
                    {result.pdf && (
                      <Button onClick={() => save(result.pdf!)} variant="outline" size="lg" data-testid="download-pdf">
                        <Download /> Download PDF
                      </Button>
                    )}
                    <Button onClick={anotherLanguage} variant="ghost" size="lg">
                      <Languages /> Another language
                    </Button>
                    <Button onClick={reset} variant="ghost" size="lg">
                      <RotateCcw /> Start over
                    </Button>
                  </div>
                }
                next={result.pdf ? { slugs: NEXT_STEPS, onPick: (s) => void openIn(s, result.pdf!.blob, result.pdf!.name), failed: nextFailed } : undefined}
                nextNote="The other tools take PDFs; this language comes as a Word file."
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
              <Preview blocks={result.preview} lang={result.lang} />
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
              <input
                ref={input}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                hidden
                aria-hidden
                tabIndex={-1}
                data-testid="pdf-input"
                onChange={(e) => {
                  void open(e.target.files);
                  e.target.value = "";
                }}
              />
              {service && !service.available && (
                <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200" data-testid="unavailable">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Translation isn&apos;t available right now. You can still turn the PDF into a Word file with{" "}
                    <Link href="/tools/pdf-to-word" className="font-semibold underline underline-offset-2">
                      PDF to Word
                    </Link>
                    .
                  </span>
                </p>
              )}

              {!loaded ? (
                <ToolDropzone
                  label={status === "reading" ? "Reading your document…" : "Drop a PDF to translate"}
                  dragLabel="Release to open"
                  busy={status === "reading"}
                  disabled={status === "reading"}
                  icon={Languages}
                  tileClassName="bg-gradient-to-br from-sky-500 to-violet-500 text-white shadow-lg shadow-primary/30"
                  onFiles={(files) => void open(files)}
                  data-testid="drop"
                >
                  {status === "reading" ? (
                    <div ref={focusRef("reading")} className="mx-auto mt-4 w-full max-w-xs rounded-xl outline-none" data-progress tabIndex={-1}>
                      <ProgressBar value={reading ? reading.page / reading.total : null} label="Reading the document" />
                      <p className="mt-2 text-sm text-muted-foreground">{reading ? `Page ${chars(reading.page)} of ${chars(reading.total)}` : "Opening…"}</p>
                      <Button variant="ghost" className="mt-1 h-11 text-muted-foreground" onClick={cancel}>
                        <X /> Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Button ref={focusRef("choose")} className="mt-4 h-11" onClick={() => input.current?.click()}>
                        <UploadCloud /> Choose PDF
                      </Button>
                      <p className="mt-4 text-xs text-muted-foreground">
                        Up to {formatLimitBytes(limits.maxFileBytes)}. The file stays on your device; only its text is sent to our AI provider to be translated.
                      </p>
                    </>
                  )}
                </ToolDropzone>
              ) : (
                <fieldset disabled={working} className="min-w-0 space-y-4">
                  <legend className="sr-only">The document and the languages</legend>
                  <motion.div
                    ref={focusRef("file")}
                    tabIndex={-1}
                    initial={{ opacity: 0, y: -6 }}
                    animate={ENTER.animate}
                    className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="file"
                  >
                    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
                      <FileIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={loaded.file.name}>
                        {loaded.file.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(loaded.file.size)} · {plural(loaded.parsed.pageCount, "page")} · {chars(loaded.plan.chars)} characters to translate
                      </p>
                    </div>
                    {!working && (
                      <button
                        type="button"
                        onClick={reset}
                        className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:p-2.5"
                        aria-label={`Remove ${loaded.file.name}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </motion.div>

                  {scans.length > 0 && (
                    <Notice block>
                      {scansNote(scans)} {scans.length === 1 ? "Its words aren't text yet, so it won't" : "Their words aren't text yet, so they won't"} be translated.{" "}
                      <Link
                        href="/tools/ocr-pdf"
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey) return;
                          e.preventDefault();
                          void openIn("ocr-pdf", loaded.file, loaded.file.name);
                        }}
                        className="whitespace-nowrap font-semibold underline underline-offset-2"
                      >
                        Run OCR PDF first
                      </Link>{" "}
                      to include {scans.length === 1 ? "it" : "them"}.
                    </Notice>
                  )}

                  <div className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <LanguagePicker
                        id="translate-target"
                        label="Translate into"
                        value={target}
                        onChange={(code) => {
                          setTarget(code);
                          setTargetMissing(false);
                          if (error?.message === "Choose the language to translate into.") fail(null);
                        }}
                        inputRef={(el) => {
                          targetRef.current = el;
                          focusRef("target")(el);
                        }}
                        invalid={targetMissing}
                      />
                      <LanguagePicker id="translate-source" label="From" value={source} onChange={setSource} auto />
                    </div>
                    <p className="text-xs text-muted-foreground" data-testid="formats">
                      {lang ? (pdfSupported(lang) ? `You'll get a Word file (DOCX) and a PDF in ${lang.name}.` : docxOnlyReason(lang)) : "You'll get a Word file (DOCX), and a PDF for languages written in Latin, Greek, Cyrillic or Devanagari letters."}
                    </p>
                    <div className="space-y-2 rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground" data-testid="privacy">
                      <p className="flex items-start gap-2">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span>
                          <span className="font-semibold text-foreground">What&apos;s sent:</span> the document&apos;s text, not the file, goes through our server to our AI provider, the one Chat with PDF uses, to be translated. We don&apos;t store it. Don&apos;t translate documents you aren&apos;t allowed to share with a third party.{" "}
                          <Link href="/privacy#ai" className="whitespace-nowrap font-semibold underline underline-offset-2">
                            Privacy policy
                          </Link>
                        </span>
                      </p>
                      <p className="flex items-start gap-2">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span>Machine translation: quality varies by language, and less widely written ones can have mistakes. Check it before you rely on it.</span>
                      </p>
                    </div>
                    {service?.available && service.remaining != null && (
                      <p className={cn("text-xs", over ? "font-medium text-amber-800 dark:text-amber-300" : "text-muted-foreground")} data-testid="allowance">
                        {over ? (
                          <>
                            {overMessage(charge, service.remaining)}{" "}
                            <Link href="/tools/split-pdf" className="font-semibold underline underline-offset-2">
                              Split PDF
                            </Link>{" "}
                            to translate part of it
                            {upgradable ? (
                              <>
                                , or{" "}
                                <button type="button" className="font-semibold underline underline-offset-2" onClick={() => setUpsell("translate-size")}>
                                  see the plans
                                </button>
                                .
                              </>
                            ) : (
                              ", or translate it after midnight UTC, when the day's allowance starts again."
                            )}
                          </>
                        ) : (
                          `${partial ? "The rest counts" : "Counts"} as ${chars(charge)} of the ${chars(service.remaining)} characters you have left today: each request is rounded up to the next 500.`
                        )}
                      </p>
                    )}
                  </div>
                </fieldset>
              )}

              {stopped && stopped.key === key && status === "ready" && (
                <Notice block>
                  <span data-testid="stopped">
                    {stopped.cancelled && `Stopped after ${chars(stopped.done)} of ${plural(stopped.total, "passage")}. `}
                    {stopped.done > 0 && stopped.done < stopped.total
                      ? `${stopped.cancelled ? (stopped.done === 1 ? "It's" : "They're") : `The ${plural(stopped.done, "passage")} translated so far ${stopped.done === 1 ? "is" : "are"}`} kept here, so translating again sends only the rest. `
                      : ""}
                    {stopped.used != null && (stopped.used ? `That counted ${chars(stopped.used)} characters of today's allowance.` : "Nothing was counted.")}
                  </span>
                </Notice>
              )}

              <AnimatePresence>
                {error && (
                  <InlineError
                    key="error"
                    shakeKey={errorKey}
                    message={<ErrorHelp message={error.message} slug={slug} files={failedFile ? [failedFile] : []} onLeave={nudge.cancel} />}
                  >
                    {error.login && (
                      <Link href={`/login?redirect=/tools/${slug}`} className="font-semibold underline">
                        Sign in
                      </Link>
                    )}
                  </InlineError>
                )}
              </AnimatePresence>

              {loaded && (
                <motion.div initial={ENTER.initial} animate={ENTER.animate} exit={FADE_EXIT} className="relative flex flex-col items-center gap-3">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {working ? (
                      <motion.div
                        key="progress"
                        ref={focusRef("progress")}
                        tabIndex={-1}
                        data-progress
                        initial={HANDOFF.in.initial}
                        animate={HANDOFF.in.animate}
                        exit={FADE_EXIT}
                        className="w-full max-w-md rounded-xl outline-none"
                      >
                        <motion.div initial={HANDOFF.track.initial} animate={HANDOFF.track.animate}>
                          <ProgressBar
                            value={status === "writing" ? writing?.fraction : progress && progress.total ? progress.done / progress.total : null}
                            determinate={status === "translating" && !!progress}
                            label="Translation progress"
                          />
                        </motion.div>
                        <p aria-hidden className="mt-2 flex items-center justify-center gap-1.5 text-center text-sm text-muted-foreground" data-testid="progress-label">
                          <WorkingGlyph />
                          <span className="relative min-w-0 truncate">
                            {status === "writing"
                              ? writing?.label ?? "Writing the files"
                              : waiting
                                ? `Many requests at once: going on in ${waiting} s`
                                : progress
                                  ? (
                                      <>
                                        {/* The short form fits the narrowest phones. */}
                                        <span className="hidden sm:inline">Translating </span>
                                        {`${chars(progress.done)} of ${chars(progress.total)} passages`}
                                      </>
                                    )
                                  : "Translating…"}
                          </span>
                          {status === "translating" && <ProgressPercent value={progress && progress.total ? progress.done / progress.total : null} />}
                        </p>
                        <p className="sr-only" aria-live="polite">
                          {progressNote(status, progress)}
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
                          onClick={() => void translate()}
                          data-cast
                          data-testid="run"
                          className="min-w-52 shadow-lg shadow-primary/25"
                          disabled={service?.available === false}
                        >
                          <Languages /> {lang ? `${partial ? "Translate the rest into" : "Translate into"} ${lang.name}` : "Translate PDF"}
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

function overMessage(charge: number, remaining: number) {
  const needs = `Translating this counts as ${chars(charge)} characters`;
  return remaining > 0 ? `${needs}; you have ${chars(remaining)} left today.` : `${needs}, and you've used today's allowance.`;
}

function scansNote(pages: number[]) {
  const text = pagesText(pages);
  return `${text[0].toUpperCase()}${text.slice(1)} ${pages.length === 1 ? "is a scan" : "are scans"}.`;
}

/** Told in steps, not every passage, so a screen reader isn't still reading when it's done. */
function progressNote(status: Status, p: { done: number; total: number } | null): string {
  if (status === "writing") return "Writing the files…";
  if (!p || !p.total) return "Translating…";
  const quarter = Math.min(3, Math.floor((p.done / p.total) * 4));
  return quarter <= 0 ? "Translating…" : `${quarter * 25}% translated`;
}

function Notice({ children, block = false }: { children: React.ReactNode; block?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-start gap-1 rounded-lg bg-amber-100 px-2.5 py-1 text-left font-medium text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
        block && "flex px-4 py-3 text-sm font-normal"
      )}
    >
      <Info className={cn("mt-0.5 h-3 w-3 shrink-0", block && "h-4 w-4")} />
      <span>{children}</span>
    </span>
  );
}

/**
 * The start of the translation, as plain text: nothing in it is ever read
 * as HTML. Each block takes its own direction, so a passage left in the
 * original language reads right inside an Arabic or Hebrew translation.
 */
function Preview({ blocks: items, lang }: { blocks: Block[]; lang: Language }) {
  if (!items.length) return null;
  return (
    <section aria-labelledby="translate-preview" className="rounded-3xl border border-border bg-card p-5 sm:p-6">
      <h3 id="translate-preview" className="flex items-center gap-2 text-sm font-semibold">
        <FileText className="h-4 w-4 text-primary" /> The start of the translation
      </h3>
      <div
        lang={lang.code}
        dir={lang.rtl ? "rtl" : "ltr"}
        tabIndex={0}
        role="region"
        aria-label="Translation preview"
        className="mt-3 max-h-80 space-y-2.5 overflow-y-auto rounded-xl bg-secondary/40 p-4 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="preview"
      >
        {items.map((b, i) =>
          b.type === "heading" ? (
            <p key={i} dir="auto" className="font-semibold">
              {b.text}
            </p>
          ) : b.type === "paragraph" ? (
            <p key={i} dir="auto">
              {b.text}
            </p>
          ) : b.type === "list" ? (
            <ul key={i} className={cn("space-y-1 ps-5", b.ordered ? "list-decimal" : "list-disc")}>
              {b.items.map((item, j) => (
                <li key={j} dir="auto">
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <div key={i} className="overflow-x-auto">
              <table className="w-full border-collapse text-start text-xs">
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r} className="border-b border-border/60 last:border-0">
                      {row.map((cell, c) => (
                        <td key={c} dir="auto" className={cn("px-2 py-1.5 align-top", r === 0 && "font-semibold")}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Download the files for the whole document.</p>
    </section>
  );
}
