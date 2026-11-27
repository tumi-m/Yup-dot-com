"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import * as Tabs from "@radix-ui/react-tabs";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ClipboardPaste, Code2, Download, FileCode2, FileText, Globe, Link2, RotateCcw, ShieldCheck, Timer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS, SPRING_LAYOUT } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { pasteBlockedMessage } from "@/lib/clipboard";
import { LIMITS, type Tier } from "@/lib/limits";
import { linkIn } from "@/lib/media";
import { fileToHandoff, handoffToFile, takeHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { cn, formatBytes } from "@/lib/utils";
import {
  DEFAULT_OPTIONS,
  HTML_NAME,
  MARGIN_LABEL,
  MAX_HTML_BYTES,
  PAGE_URL_MESSAGE,
  SIZE_LABEL,
  decodeHtml,
  defaultSize,
  formatHtmlLimit,
  htmlBytes,
  htmlDigest,
  webPageUrl,
  wellFormed,
  type Margins,
  type PageMedia,
  type PageSize,
  type WebPdfOptions,
} from "@/lib/web-pdf";
import { emptyMessage } from "./file-pick";

type Source = "url" | "file" | "paste";
type Phase = "input" | "working" | "done";
/** Where a run is, as the page says it. */
type Stage = "link" | "sending" | "queued" | "loading" | "printing" | "fetching";

const NEXT_STEPS = ["compress-pdf", "merge-pdf", "edit-pdf"];
const OPTIONS_KEY = "pdfw-web-pdf-options";
/** Give up on a job that never finishes rather than spin forever (the worker stops at 60 s, plus a queue). */
const POLL_DEADLINE_MS = 150_000;
const POLL_MAX_FAILURES = 5;

const STAGE_LABEL: Record<Stage, string> = {
  link: "Checking…",
  sending: "Sending your HTML…",
  queued: "Waiting for a free browser…",
  loading: "Opening the page…",
  printing: "Making the PDF…",
  fetching: "Downloading the PDF…",
};

interface Result {
  blob: Blob;
  name: string;
  pages: number;
  cut: boolean;
  seconds: number;
}

/** "Too many" and "no answer" from our route or the worker, as words. */
class Shown extends Error {
  constructor(
    message: string,
    readonly upgrade = false
  ) {
    super(message);
  }
}

function loadOptions(): WebPdfOptions {
  const fallback = { ...DEFAULT_OPTIONS, size: defaultSize(typeof navigator === "undefined" ? undefined : navigator.language) };
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null") as Partial<WebPdfOptions> | null;
    if (!saved || typeof saved !== "object") return fallback;
    return {
      size: (["a4", "letter", "fit"] as const).includes(saved.size as PageSize) ? (saved.size as PageSize) : fallback.size,
      orientation: saved.orientation === "landscape" ? "landscape" : "portrait",
      margins: (["none", "small", "large"] as const).includes(saved.margins as Margins) ? (saved.margins as Margins) : fallback.margins,
      background: saved.background !== false,
      media: saved.media === "print" ? "print" : "screen",
    };
  } catch {
    return fallback;
  }
}

function saveOptions(o: WebPdfOptions) {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* site data blocked: the choice lasts this visit */
  }
}

/** One line for the closed settings: what the PDF will be. */
function summary(o: WebPdfOptions): string {
  const parts = [SIZE_LABEL[o.size]];
  if (o.size !== "fit") parts.push(o.orientation === "landscape" ? "Landscape" : "Portrait");
  parts.push(o.margins === "none" ? "No margins" : `${o.margins === "small" ? "Small" : "Large"} margins`);
  parts.push(o.media === "print" ? "Print version" : "As on screen");
  if (!o.background) parts.push("No backgrounds");
  return parts.join(" · ");
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const selectClass =
  "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:h-10 sm:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function WebToPdf({ slug, tier }: { slug: string; tier: Tier }) {
  const router = useRouter();
  const params = useSearchParams();
  const reduce = useReducedMotion();
  const paid = tier === "pro" || tier === "team";
  const [source, setSource] = useState<Source>("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<{ name: string; size: number; html: string } | null>(null);
  const [pasted, setPasted] = useState("");
  const [options, setOptions] = useState<WebPdfOptions>(DEFAULT_OPTIONS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [stage, setStage] = useState<Stage>("link");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<{ message: string; upgrade?: boolean } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  /** The worker's job, so Cancel (or leaving) can stop it. */
  const job = useRef<{ workerUrl: string; id: string } | null>(null);
  /** The run's grant until it has a PDF: a try that fails may be given back. */
  const grantToken = useRef<string | null>(null);
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"input" | "progress" | "done">();
  const flow = useHeightLock<HTMLDivElement>();

  // Options from the last visit, and the paper this visitor's country uses.
  useEffect(() => setOptions(loadOptions()), []);

  // An .html file dropped on the homepage.
  useEffect(() => {
    if (params.get("handoff") !== "1") return;
    takeHandoff()
      .then((handed) => {
        const html = handed.find((h) => HTML_NAME.test(h.name) || h.type === "text/html");
        if (!html) return;
        setSource("file");
        void chooseFile([handoffToFile(html)]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ?url= fills in the box; it never starts by itself.
  useEffect(() => {
    const link = params.get("url");
    if (!link) return;
    window.history.replaceState(window.history.state, "", window.location.pathname);
    setUrl(link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      abort.current?.abort();
      stopJob();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  function setOption<K extends keyof WebPdfOptions>(key: K, value: WebPdfOptions[K]) {
    setOptions((o) => {
      const next = { ...o, [key]: value };
      saveOptions(next);
      return next;
    });
  }

  const urlProblem = source === "url" && url.trim() ? webPageUrl(linkIn(url)) : null;
  const shownUrlProblem = urlProblem && "problem" in urlProblem && urlProblem.problem !== "empty" ? PAGE_URL_MESSAGE[urlProblem.problem] : null;
  const pastedBytes = source === "paste" ? htmlBytes(pasted) : 0;
  const ready = source === "url" ? !!url.trim() : source === "file" ? !!file : !!pasted.trim();

  /** Focus is in this tool (or was dropped to the page by a view that left it). */
  const focusHere = () => document.activeElement === document.body || !!flow.ref.current?.contains(document.activeElement);

  /** Asks for a failed or cancelled try back (/api/render/refund decides). True if it was. */
  async function giveBack(): Promise<boolean> {
    const token = grantToken.current;
    grantToken.current = null;
    if (!token) return false;
    const res = await fetch("/api/render/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      keepalive: true,
    }).catch(() => null);
    return !!(await res?.json().catch(() => null))?.refunded;
  }

  /** Stops the worker's job, then asks for the try back. */
  function stopJob() {
    const j = job.current;
    job.current = null;
    const stopped = j ? fetch(`${j.workerUrl}/render/${j.id}`, { method: "DELETE", keepalive: true }).catch(() => null) : Promise.resolve(null);
    void stopped.then(() => giveBack());
  }

  async function chooseFile(list: FileList | File[] | null) {
    const picked = list?.length ? Array.from(list)[0] : null;
    if (!picked) return;
    setError(null);
    if (!HTML_NAME.test(picked.name) && picked.type !== "text/html" && picked.type !== "application/xhtml+xml") {
      setError({ message: /\.(mht|mhtml|webarchive)$/i.test(picked.name) ? "Save the page as “Web page, HTML only” first, or paste its address." : "Choose an .html file." });
      return;
    }
    const empty = emptyMessage([picked]);
    if (empty) {
      setError({ message: empty });
      return;
    }
    if (picked.size > MAX_HTML_BYTES * 2) {
      setError({ message: `HTML files up to ${formatHtmlLimit()} can be saved.` });
      return;
    }
    const html = wellFormed(decodeHtml(new Uint8Array(await picked.arrayBuffer())));
    if (htmlBytes(html) > MAX_HTML_BYTES) {
      setError({ message: `HTML files up to ${formatHtmlLimit()} can be saved.` });
      return;
    }
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "input";
    setFile({ name: picked.name, size: picked.size, html });
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(linkIn(text));
    } catch {
      setError({ message: pasteBlockedMessage() });
    }
  }

  async function run() {
    if (phase === "working") return;
    setError(null);
    setNextFailed(null);
    let body: Record<string, unknown>;
    let html: string | null = null;
    // An uploaded file's PDF is named here, after it: the name isn't sent anywhere.
    let name: string | null = null;
    if (source === "url") {
      const checked = webPageUrl(linkIn(url));
      if ("problem" in checked) {
        setError({ message: PAGE_URL_MESSAGE[checked.problem] });
        return;
      }
      setUrl(checked.url);
      body = { mode: "url", url: checked.url, options };
    } else {
      html = source === "file" ? (file?.html ?? "") : wellFormed(pasted);
      name = source === "file" && file ? `${file.name.replace(HTML_NAME, "").trim() || "page"}.pdf` : null;
      if (!html.trim()) {
        setError({ message: source === "file" ? "Choose an .html file." : "Paste some HTML first." });
        return;
      }
      const bytes = htmlBytes(html);
      if (bytes > MAX_HTML_BYTES) {
        setError({ message: `HTML up to ${formatHtmlLimit()} can be saved. This is ${formatBytes(bytes)}.` });
        return;
      }
      body = { mode: "html", bytes, sha256: await htmlDigest(html), options };
    }

    const hadFocus = !!flow.ref.current?.contains(document.activeElement);
    flow.lock(resultFloor());
    if (hadFocus) focusNext.current = "progress";
    const controller = new AbortController();
    abort.current = controller;
    const signal = controller.signal;
    const started = performance.now();
    setStage("link");
    setProgress(0.02);
    setPhase("working");
    try {
      const made = await makePdf(body, html, signal);
      if (!made || signal.aborted) return;
      grantToken.current = null;
      if (name) made.name = name;
      setProgress(1);
      if (!reduce) await sleep(PROGRESS_HOLD_MS, signal);
      if (signal.aborted) return;
      setResult({ ...made, seconds: (performance.now() - started) / 1000 });
      setDownloaded(false);
      if (hadFocus || focusHere()) focusNext.current = "done";
      settleSlot(flow.ref.current);
      setPhase("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch (err) {
      if (signal.aborted) return;
      const shown = err instanceof Shown ? err : new Shown("Couldn't make a PDF of this page. Try again.");
      const back = await giveBack();
      if (signal.aborted) return;
      setError({ message: back ? `${shown.message} This try wasn't counted.` : shown.message, upgrade: shown.upgrade });
      if (hadFocus || focusHere()) focusNext.current = "input";
      flow.release();
      setPhase("input");
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }

  /** The grant, the worker's job, then the file. Null when cancelled. */
  async function makePdf(body: Record<string, unknown>, html: string | null, signal: AbortSignal) {
    const res = await fetch("/api/render/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }).catch(() => null);
    if (signal.aborted) return null;
    const grant = await res?.json().catch(() => null);
    if (!res?.ok || !grant?.token) {
      if (grant?.reason === "quota") {
        if (!paid) setUpsell("web-pdfs");
        throw new Shown(grant.error, !paid);
      }
      throw new Shown(grant?.error ?? (res ? "Couldn't make a PDF of this page. Try again." : "You're offline. Check your connection."));
    }
    const workerUrl: string = grant.workerUrl;
    grantToken.current = grant.token;
    // "Waiting for a free browser" only once the worker says the job waits.
    setStage(html !== null ? "sending" : "loading");
    setProgress(0.05);
    // Not aborted on Cancel: the answer is needed to stop the job it may have started.
    const created = await fetch(`${workerUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(html !== null ? { token: grant.token, html } : { token: grant.token }),
    }).catch(() => null);
    const made = await created?.json().catch(() => null);
    if (made?.id) job.current = { workerUrl, id: made.id };
    if (signal.aborted) {
      stopJob();
      return null;
    }
    if (!created?.ok || !made?.id) throw new Shown(made?.error ?? "The PDF server isn't responding. Try again in a minute.");

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let failures = 0;
    for (;;) {
      await sleep(700, signal);
      if (signal.aborted) return null;
      if (Date.now() > deadline) {
        stopJob();
        throw new Shown("This page is taking too long. Try again later.");
      }
      const r = await fetch(`${workerUrl}/render/${made.id}`, { cache: "no-store", signal }).catch(() => null);
      const s = await r?.json().catch(() => null);
      if (signal.aborted) return null;
      if (!r || !s) {
        if (++failures >= POLL_MAX_FAILURES) throw new Shown("Lost contact with the PDF server. Try again.");
        continue;
      }
      failures = 0;
      if (!r.ok || s.status === "error" || s.status === "gone") {
        job.current = null;
        throw new Shown(s.error ?? "Couldn't make a PDF of this page. Try again.");
      }
      if (s.stage === "queued" || s.stage === "loading" || s.stage === "printing") setStage(s.stage);
      else if (s.stage === "starting") setStage("loading");
      // The worker's share of the bar: 5% to 92%.
      setProgress((p) => Math.max(p, 0.05 + Math.min(1, Number(s.progress) || 0) * 0.87));
      if (s.status === "ready") {
        setStage("fetching");
        const file = await fetch(`${workerUrl}/render/${made.id}/file`, { cache: "no-store", signal }).catch(() => null);
        if (signal.aborted) return null;
        job.current = null;
        if (!file?.ok) {
          const why = await file?.json().catch(() => null);
          throw new Shown(why?.error ?? "The download was interrupted. Make the PDF again.");
        }
        const blob = new Blob([await file.arrayBuffer()], { type: "application/pdf" });
        return { blob, name: String(s.filename || "page.pdf"), pages: Number(s.pages) || 0, cut: !!s.cut };
      }
    }
  }

  function cancel() {
    abort.current?.abort();
    abort.current = null;
    stopJob();
    focusNext.current = "input";
    flow.release();
    setPhase("input");
  }

  function reset() {
    nudge.cancel();
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "input";
    flow.lock();
    setResult(null);
    setError(null);
    setPhase("input");
  }

  async function continueWith(nextSlug: string) {
    nudge.cancel();
    if (!result) return;
    setNextFailed(null);
    if (await tryHandoff([fileToHandoff(result.blob, result.name)])) router.push(`/tools/${nextSlug}?handoff=1`);
    else setNextFailed(nextSlug);
  }

  const working = phase === "working";
  const notice =
    source === "url" ? (
      <>
        The page is opened on our server, in a browser with no cookies or sign-in, and turned into a PDF there. The PDF is
        deleted from our server as soon as you download it. Pages behind a login or a cookie banner come out as a signed-out
        visitor sees them.
      </>
    ) : (
      <>
        Your HTML is sent to our server and turned into a PDF there, then deleted as soon as you download it. Pictures,
        styles and fonts load from the web (https://…) only: files next to it on your device aren&apos;t sent.
      </>
    );

  return (
    <>
      {/* The stage, said once each time it changes. */}
      <p className="sr-only" aria-live="polite">
        {working ? STAGE_LABEL[stage] : ""}
      </p>
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
        <AnimatePresence mode="wait" initial={false}>
          {phase === "done" && result ? (
            <SuccessCard
              key="done"
              className="flex-1"
              titleRef={focusRef("done")}
              stats={
                <>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground">
                    <Timer className="h-3 w-3" /> {result.seconds.toFixed(1)} s
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-muted-foreground" data-testid="web-pdf-stats">
                    {result.pages} page{result.pages === 1 ? "" : "s"} · {formatBytes(result.blob.size)}
                  </span>
                  {result.cut && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-amber-900" data-testid="web-pdf-cut">
                      Stopped at {result.pages} pages{paid ? "" : ` (Pro: ${LIMITS.pro.webPdfPages})`}
                    </span>
                  )}
                </>
              }
              files={[{ name: result.name, size: result.blob.size, onDownload: () => downloadBlob(result.blob, result.name) }]}
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
                  <Button onClick={reset} variant="outline" size="lg">
                    <RotateCcw /> Another page
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
            <motion.form
              key="work"
              initial={ENTER.initial}
              animate={ENTER.animate}
              exit={EXIT}
              onAnimationStart={(def) => def !== EXIT && flow.release()}
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
              className="space-y-4"
            >
              <div className="rounded-3xl border border-border bg-card p-4 shadow-xl shadow-primary/5 sm:p-5">
                <Tabs.Root
                  value={source}
                  onValueChange={(v) => {
                    setSource(v as Source);
                    setError(null);
                  }}
                >
                  <Tabs.List aria-label="What to save" className="grid grid-cols-3 gap-1 rounded-xl bg-secondary p-1">
                    {(
                      [
                        ["url", "Web page", Globe],
                        ["file", "HTML file", FileCode2],
                        ["paste", "Paste HTML", Code2],
                      ] as const
                    ).map(([value, label, Icon]) => (
                      <Tabs.Trigger
                        key={value}
                        value={value}
                        disabled={working}
                        data-testid={`source-${value}`}
                        className={cn(
                          "relative flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-sm font-medium outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-[380px]:px-1 max-[380px]:text-xs",
                          source === value ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {source === value && (
                          <motion.span layoutId="web-pdf-source" className="absolute inset-0 bg-background shadow" style={{ borderRadius: 8 }} transition={SPRING_LAYOUT} />
                        )}
                        <span className="relative z-[1] flex items-center gap-1.5">
                          {/* Left out on phones, so the three labels fit in their tabs. */}
                          <Icon aria-hidden className="hidden h-4 w-4 sm:block" />
                          {label}
                        </span>
                      </Tabs.Trigger>
                    ))}
                  </Tabs.List>

                  <Tabs.Content value="url" tabIndex={-1} className="mt-4 outline-none">
                    <label htmlFor="web-pdf-url" className="mb-2 block text-sm font-medium">
                      Web page address
                    </label>
                    <div className="relative">
                      <Link2 aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        ref={focusRef("input")}
                        id="web-pdf-url"
                        value={url}
                        onChange={(e) => {
                          setUrl(e.target.value);
                          setError(null);
                        }}
                        placeholder="example.com/article"
                        inputMode="url"
                        autoComplete="url"
                        autoCapitalize="off"
                        spellCheck={false}
                        disabled={working}
                        aria-invalid={shownUrlProblem ? true : undefined}
                        aria-describedby={error ? "web-pdf-error" : shownUrlProblem ? "web-pdf-url-hint" : undefined}
                        className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-24 text-base outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 sm:text-sm"
                      />
                      <button
                        type="button"
                        onClick={paste}
                        disabled={working}
                        className="absolute right-0.5 top-1/2 flex h-11 min-w-11 -translate-y-1/2 items-center gap-1 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ClipboardPaste aria-hidden className="h-3.5 w-3.5" /> Paste
                      </button>
                    </div>
                    <AnimatePresence>
                      {shownUrlProblem && !error && (
                        <motion.p
                          id="web-pdf-url-hint"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={FADE_EXIT}
                          transition={NOTICE_T}
                          className="mt-2 text-xs text-muted-foreground"
                        >
                          {shownUrlProblem}
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </Tabs.Content>

                  <Tabs.Content value="file" tabIndex={-1} className="mt-4 outline-none">
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".html,.htm,.xhtml,text/html,application/xhtml+xml"
                      className="hidden"
                      hidden
                      aria-hidden
                      tabIndex={-1}
                      data-testid="html-input"
                      onChange={(e) => {
                        void chooseFile(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    {file ? (
                      <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-3">
                        <FileText className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{file.name}</p>
                          <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                        </div>
                        {!working && (
                          <button
                            ref={focusRef("input")}
                            type="button"
                            onClick={() => {
                              if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "input";
                              setFile(null);
                            }}
                            className="tap rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`Remove ${file.name}`}
                            aria-describedby={error ? "web-pdf-error" : undefined}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <ToolDropzone label="Drop an .html file here" onFiles={(f) => void chooseFile(f)} icon={FileCode2} className="p-6 sm:p-8">
                        <p className="text-sm text-muted-foreground">or</p>
                        <Button
                          ref={focusRef("input")}
                          type="button"
                          className="mt-3 h-11"
                          aria-describedby={error ? "web-pdf-error" : undefined}
                          onClick={() => fileInput.current?.click()}
                        >
                          Choose file
                        </Button>
                      </ToolDropzone>
                    )}
                  </Tabs.Content>

                  <Tabs.Content value="paste" tabIndex={-1} className="mt-4 outline-none">
                    <label htmlFor="web-pdf-html" className="mb-2 block text-sm font-medium">
                      HTML
                    </label>
                    <textarea
                      ref={focusRef("input")}
                      id="web-pdf-html"
                      value={pasted}
                      onChange={(e) => {
                        setPasted(e.target.value);
                        setError(null);
                      }}
                      rows={7}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                      disabled={working}
                      placeholder={"<h1>Hello</h1>\n<p>Paste a whole page or just a part of one.</p>"}
                      aria-describedby={error ? "web-pdf-html-size web-pdf-error" : "web-pdf-html-size"}
                      className="block w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 font-mono text-base leading-relaxed outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 sm:text-sm"
                    />
                    <p id="web-pdf-html-size" className={cn("mt-1.5 text-xs tabular-nums", pastedBytes > MAX_HTML_BYTES ? "text-destructive" : "text-muted-foreground")}>
                      {formatBytes(pastedBytes)} of {formatHtmlLimit()}
                    </p>
                  </Tabs.Content>
                </Tabs.Root>

                {/* Next to the field focus goes back to, so a phone shows both. */}
                <div id="web-pdf-error">
                  <AnimatePresence>
                    {error && (
                      <InlineError key="error" message={error.message} className="mt-3">
                        {error.upgrade && !paid && (
                          <Link href="/pricing" className="tap font-semibold underline underline-offset-2">
                            Upgrade
                          </Link>
                        )}
                      </InlineError>
                    )}
                  </AnimatePresence>
                </div>

                <div className="mt-4 rounded-2xl border border-border">
                  <button
                    type="button"
                    onClick={() => setSettingsOpen((o) => !o)}
                    aria-expanded={settingsOpen}
                    aria-controls="web-pdf-settings"
                    disabled={working}
                    className="flex min-h-11 w-full items-center gap-2 rounded-2xl px-4 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    <span className="font-medium">Page settings</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-testid="web-pdf-summary">
                      {summary(options)}
                    </span>
                    <ChevronDown aria-hidden className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast motion-reduce:transition-none", settingsOpen && "rotate-180")} />
                  </button>
                  <AnimatePresence initial={false}>
                    {settingsOpen && (
                      <motion.div
                        id="web-pdf-settings"
                        key="settings"
                        initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                        animate={reduce ? { opacity: 1 } : { opacity: 1, height: "auto" }}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                        transition={NOTICE_T}
                        className="overflow-hidden"
                      >
                        <div className="grid gap-4 border-t border-border p-4 sm:grid-cols-2">
                          <div>
                            <label htmlFor="web-pdf-size" className="mb-1.5 block text-sm font-medium">
                              Page size
                            </label>
                            <select id="web-pdf-size" value={options.size} disabled={working} onChange={(e) => setOption("size", e.target.value as PageSize)} className={selectClass}>
                              {(["a4", "letter", "fit"] as const).map((s) => (
                                <option key={s} value={s}>
                                  {SIZE_LABEL[s]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label htmlFor="web-pdf-orientation" className="mb-1.5 block text-sm font-medium">
                              Orientation
                            </label>
                            <select
                              id="web-pdf-orientation"
                              value={options.orientation}
                              disabled={working || options.size === "fit"}
                              aria-describedby={options.size === "fit" ? "web-pdf-fit-hint" : undefined}
                              onChange={(e) => setOption("orientation", e.target.value === "landscape" ? "landscape" : "portrait")}
                              className={selectClass}
                            >
                              <option value="portrait">Portrait</option>
                              <option value="landscape">Landscape</option>
                            </select>
                            {options.size === "fit" && (
                              <p id="web-pdf-fit-hint" className="mt-1.5 text-xs text-muted-foreground">
                                One long page is as wide as a computer screen.
                              </p>
                            )}
                          </div>
                          <div>
                            <label htmlFor="web-pdf-margins" className="mb-1.5 block text-sm font-medium">
                              Margins
                            </label>
                            <select id="web-pdf-margins" value={options.margins} disabled={working} onChange={(e) => setOption("margins", e.target.value as Margins)} className={selectClass}>
                              {(["none", "small", "large"] as const).map((m) => (
                                <option key={m} value={m}>
                                  {MARGIN_LABEL[m]}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label htmlFor="web-pdf-media" className="mb-1.5 block text-sm font-medium">
                              Layout
                            </label>
                            <select
                              id="web-pdf-media"
                              value={options.media}
                              disabled={working}
                              aria-describedby="web-pdf-media-hint"
                              onChange={(e) => setOption("media", e.target.value as PageMedia)}
                              className={selectClass}
                            >
                              <option value="screen">As on screen</option>
                              <option value="print">Print version</option>
                            </select>
                            <p id="web-pdf-media-hint" className="mt-1.5 text-xs text-muted-foreground">
                              {options.media === "print" ? "The site's printer-friendly layout, if it has one." : "Menus and colours as you see them."}
                            </p>
                          </div>
                          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium sm:col-span-2">
                            <input
                              type="checkbox"
                              checked={options.background}
                              disabled={working}
                              onChange={(e) => setOption("background", e.target.checked)}
                              className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                            />
                            Background colours and pictures
                          </label>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <p className="mt-4 flex gap-2 text-xs leading-relaxed text-muted-foreground" data-testid="web-pdf-notice">
                  <ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>{notice}</span>
                </p>

                <div className="relative mt-4">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {working ? (
                      <motion.div
                        key="progress"
                        ref={focusRef("progress")}
                        tabIndex={-1}
                        initial={HANDOFF.in.initial}
                        animate={HANDOFF.in.animate}
                        exit={FADE_EXIT}
                        className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <motion.div initial={HANDOFF.track.initial} animate={HANDOFF.track.animate}>
                          <ProgressBar value={progress} determinate label="Making the PDF" />
                        </motion.div>
                        <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-sm text-muted-foreground">
                          <WorkingGlyph />
                          <span aria-hidden className="inline-flex gap-1.5" data-testid="web-pdf-stage">
                            {STAGE_LABEL[stage]}
                            <ProgressPercent value={progress} />
                          </span>
                          <Button type="button" variant="ghost" size="sm" className="tap" onClick={cancel} data-testid="cancel-web-pdf">
                            Cancel
                          </Button>
                        </p>
                      </motion.div>
                    ) : (
                      <motion.div key="go" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1, transition: NOTICE_T }} exit={HANDOFF.out}>
                        <Button type="submit" size="lg" className="h-12 w-full shadow-lg shadow-primary/25" disabled={!ready} data-testid="make-pdf">
                          <Download /> Save as PDF
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
      {upsell && <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo={`/tools/${slug}`} />}
    </>
  );
}
