"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  ClipboardPaste,
  Clock,
  Crown,
  Download,
  FileSpreadsheet,
  FileText,
  Film,
  Link2,
  ListVideo,
  Loader2,
  Music2,
  RotateCcw,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProgressFill } from "@/components/tools/MediaDownloader";
import { EASE, SPRING } from "@/components/motion/primitives";
import { UpgradeDialog, type UpsellReason } from "@/components/upsell/Upsell";
import { parseMediaUrl, parsePlaylistUrl, type MediaKind } from "@/lib/media";
import { exportName, formatDuration, playlistCsv, playlistTxt, type PlaylistEntry } from "@/lib/playlist";
import type { Tier } from "@/lib/limits";
import { cn } from "@/lib/utils";
import { trackDownload, trackToolUsed } from "@/lib/analytics";

interface Playlist {
  id: string;
  url: string;
  title: string;
  uploader: string | null;
  count: number;
  truncated: boolean;
  entries: PlaylistEntry[];
  qualities: { height: number; locked: boolean }[];
}

type Status = "idle" | "queued" | "downloading" | "ready" | "failed";

interface Item {
  status: Status;
  progress: number;
  error?: string;
  href?: string;
  filename?: string;
}

/** Two at a time: quick, without hogging the worker's slots. */
const PARALLEL = 2;
const POLL_DEADLINE_MS = 20 * 60 * 1000;
const POLL_MAX_FAILURES = 6;

class Halt extends Error {
  constructor(public reason: UpsellReason | "limit") {
    super(reason);
  }
}

/** The download server is down or misconfigured: every other video would fail the same way. */
class ServerDown extends Error {}

/** Gives a download back when its job failed or never ran (the server checks with the worker). */
function refund(token: string) {
  void fetch("/api/media/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => null);
}

function saveAs(href: string, name?: string) {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * A worker file downloads by navigating to it, and a second navigation that
 * starts before the first response arrives cancels it. Two videos finishing
 * together would lose one file, so saves go out one at a time, spaced apart.
 */
let saveQueue: Promise<void> = Promise.resolve();
const SAVE_GAP_MS = 1500;
function queueSave(href: string) {
  saveQueue = saveQueue.then(() => {
    saveAs(href);
    return new Promise((r) => setTimeout(r, SAVE_GAP_MS));
  });
}

function saveText(text: string, name: string, type: string) {
  trackDownload(name);
  const href = URL.createObjectURL(new Blob([text], { type }));
  saveAs(href, name);
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Resolves early when the run is stopped. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

export function PlaylistDownloader({ tier }: { tier: Tier }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const [url, setUrl] = useState(() => params.get("url")?.trim() ?? "");
  const [scope, setScope] = useState<"playlist" | "video">("playlist");
  const [phase, setPhase] = useState<"input" | "loading" | "list">("input");
  const [list, setList] = useState<Playlist | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<MediaKind>("mp4");
  const [height, setHeight] = useState(720);
  const [items, setItems] = useState<Record<string, Item>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);

  const alive = useRef(true);
  const queue = useRef<string[]>([]);
  const active = useRef(0);
  const halted = useRef(false);
  /** Bumped by "Different link", so downloads still running for the old list are ignored. */
  const generation = useRef(0);
  const settings = useRef({ kind, height });
  /** Aborted by Stop: running downloads end and their worker jobs are cancelled. */
  const run = useRef(new AbortController());
  /** Rows as they were before a retry, restored if the retry never starts. */
  const before = useRef<Record<string, Item>>({});
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current = [];
    };
  }, []);

  const playlist = url ? parsePlaylistUrl(url) : null;
  const single = !playlist && url ? parseMediaUrl(url) : null;
  const wantsVideo = !!playlist?.video && scope === "video";

  // A ?url= link (e.g. from the homepage) lists the playlist straight away.
  const autoLookup = useRef(false);
  useEffect(() => {
    if (autoLookup.current) return;
    autoLookup.current = true;
    if (playlist) void lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (id: string, change: Partial<Item>) => {
    if (!alive.current) return;
    setItems((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { status: "idle", progress: 0 }), ...change } }));
  };

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!playlist) {
      if (!single) setError("Paste a YouTube playlist link.");
      return;
    }
    if (wantsVideo && playlist.video) {
      router.push(`/tools/youtube-to-mp4?url=${encodeURIComponent(playlist.video.canonical)}`);
      return;
    }
    setPhase("loading");
    const res = await fetch("/api/media/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    if (!alive.current) return;
    if (!res?.ok || !data) {
      setError(data?.error ?? (res ? "Couldn't read that playlist." : "You're offline. Check your connection."));
      setPhase("input");
      return;
    }
    const pl = data as Playlist;
    setList(pl);
    syncAddress(pl.url);
    setSelected(new Set(pl.entries.map((x) => x.id)));
    setItems({});
    setLimitHit(false);
    const best = [...pl.qualities].reverse().find((q) => !q.locked && q.height <= 720);
    setHeight(best?.height ?? 360);
    setPhase("list");
  }

  /** Keeps the address bar in step, so refresh and sharing show the same list. */
  function syncAddress(link: string | null) {
    const next = link ? `${pathname}?url=${encodeURIComponent(link)}` : pathname;
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(null, "", next);
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setError("Clipboard blocked. Paste with Ctrl+V.");
    }
  }

  // ---------------------------------------------------------------------
  // Download queue: each video goes through /api/media/link (plan + quota)
  // and then a worker job, exactly like a single download.
  // ---------------------------------------------------------------------

  function enqueue(ids: string[]) {
    if (!ids.length) return;
    halted.current = false;
    if (run.current.signal.aborted) run.current = new AbortController();
    setLimitHit(false);
    setError(null);
    for (const id of ids) {
      if (!queue.current.includes(id)) queue.current.push(id);
      if (items[id]?.status === "failed") before.current[id] = items[id];
      patch(id, { status: "queued", progress: 0, error: undefined });
    }
    pump();
  }

  /** Back to how the row was before it was queued (a failed row keeps its error). */
  const unqueue = (id: string) => {
    const prev = before.current[id];
    delete before.current[id];
    patch(id, prev ?? { status: "idle", progress: 0, error: undefined });
  };

  function pump() {
    if (!alive.current) return;
    while (active.current < PARALLEL && queue.current.length && !halted.current) {
      const id = queue.current.shift()!;
      const gen = generation.current;
      active.current++;
      setRunning(true);
      void runItem(id).finally(() => {
        if (!alive.current || generation.current !== gen) return;
        active.current--;
        if (active.current === 0 && (!queue.current.length || halted.current)) setRunning(false);
        pump();
      });
    }
  }

  /** Nothing more starts; downloads already running finish. */
  function stopQueue() {
    halted.current = true;
    for (const id of queue.current) unqueue(id);
    queue.current = [];
  }

  /** Stop: the queue and the downloads already running (their rows go back to how they were). */
  function stop() {
    stopQueue();
    run.current.abort();
    setItems((prev) => {
      const next = { ...prev };
      for (const [id, it] of Object.entries(prev)) {
        if (it.status === "downloading") next[id] = before.current[id] ?? { status: "idle", progress: 0 };
      }
      return next;
    });
    before.current = {};
    setRunning(false);
  }

  function halt(reason: Halt["reason"]) {
    // Downloads already running were counted, so they finish.
    stopQueue();
    setLimitHit(reason === "downloads" || reason === "limit");
    if (reason === "limit") setError("You've used today's downloads.");
    else setUpsell(reason);
  }

  async function runItem(id: string) {
    const gen = generation.current;
    const signal = run.current.signal;
    const live = () => alive.current && generation.current === gen && !signal.aborted;
    const update = (change: Partial<Item>) => live() && patch(id, change);
    const entry = list?.entries.find((x) => x.id === id);
    if (!entry || halted.current || !live()) return;
    const { kind: k, height: h } = settings.current;
    update({ status: "downloading", progress: 0 });
    try {
      const res = await fetch("/api/media/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: entry.url, kind: k, height: k === "mp4" ? h : undefined }),
      }).catch(() => null);
      const grant = await res?.json().catch(() => null);
      if (!res?.ok || grant?.mode !== "worker") {
        if (res?.status === 429) throw new Halt(grant?.upgrade ? "downloads" : "limit");
        if (grant?.upgrade) throw new Halt(grant.reason === "quality" ? "quality" : "downloads");
        const message = grant?.error ?? (res ? "Couldn't start this download." : "You're offline.");
        throw res?.status === 503 || !res ? new ServerDown(message) : new Error(message);
      }
      if (!live()) return refund(grant.token);
      const file = await runJob(grant.workerUrl, grant.token, live, signal, (p) => update({ progress: p }));
      if (!file || !live()) return;
      delete before.current[id];
      update({ status: "ready", progress: 1, href: file.href, filename: file.name });
      queueSave(file.href);
      trackToolUsed("youtube-playlist");
      trackDownload(file.name);
    } catch (err) {
      if (!live()) return;
      if (err instanceof Halt) {
        unqueue(id);
        halt(err.reason);
        return;
      }
      delete before.current[id];
      update({ status: "failed", error: err instanceof Error ? err.message : "Download failed." });
      // Don't spend the rest of the list on a server that can't answer.
      if (err instanceof ServerDown) {
        stop();
        setError(err.message);
      }
    }
  }

  /** One worker job. Failures are refunded; a stopped run cancels the job. Null when stopped. */
  async function runJob(workerUrl: string, token: string, live: () => boolean, signal: AbortSignal, onProgress: (p: number) => void) {
    const created = await fetch(`${workerUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    const job = await created?.json().catch(() => null);
    if (!created?.ok || !job?.id) {
      refund(token);
      if (!live()) return null;
      // No answer, a non-JSON page (a sleeping host) or a key mismatch: the next video would fail too.
      if (!job || job.code === "bad-signature") throw new ServerDown(job?.error ?? "The download server isn't responding.");
      throw new Error(job.error ?? "Couldn't start this download.");
    }
    const cancel = () => {
      void fetch(`${workerUrl}/jobs/${job.id}`, { method: "DELETE", keepalive: true })
        .catch(() => null)
        .finally(() => refund(token));
    };
    const failed = (message: string) => {
      refund(token);
      return new Error(message);
    };

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let failures = 0;
    await sleep(800, signal);
    while (live()) {
      if (Date.now() > deadline) {
        cancel();
        throw new Error("This one is taking too long.");
      }
      const r = await fetch(`${workerUrl}/jobs/${job.id}`, { cache: "no-store", signal }).catch(() => null);
      const s = await r?.json().catch(() => null);
      if (!live()) break;
      if (!r || !s) {
        if (++failures >= POLL_MAX_FAILURES) throw failed("Lost contact with the download server.");
      } else if (!r.ok || s.status === "error") {
        throw failed(s.error ?? "Download failed.");
      } else {
        failures = 0;
        onProgress(Number(s.progress) || 0);
        if (s.status === "ready") return { href: `${workerUrl}/jobs/${job.id}/file`, name: String(s.filename ?? "") };
      }
      await sleep(1000, signal);
    }
    cancel();
    return null;
  }

  function downloadSelected() {
    if (!list) return;
    settings.current = { kind, height };
    enqueue(list.entries.filter((x) => selected.has(x.id) && items[x.id]?.status !== "ready").map((x) => x.id));
  }

  function retry(id: string) {
    if (!running) settings.current = { kind, height };
    enqueue([id]);
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function reset() {
    stop();
    generation.current++;
    active.current = 0;
    setRunning(false);
    setList(null);
    setItems({});
    setUrl("");
    setError(null);
    setLimitHit(false);
    syncAddress(null);
    setPhase("input");
  }

  function exportList(format: "csv" | "txt") {
    if (!list) return;
    if (format === "csv") saveText(playlistCsv(list.entries), exportName(list.title, "csv"), "text/csv;charset=utf-8");
    else saveText(playlistTxt(list.entries), exportName(list.title, "txt"), "text/plain;charset=utf-8");
  }

  const entries = list?.entries ?? [];
  const allSelected = entries.length > 0 && entries.every((x) => selected.has(x.id));
  const states = Object.values(items);
  const ready = states.filter((i) => i.status === "ready").length;
  const failed = states.filter((i) => i.status === "failed").length;
  const inFlight = states.filter((i) => i.status === "queued" || i.status === "downloading");
  const started = states.filter((i) => i.status !== "idle").length;
  const overall = started
    ? states.reduce((sum, i) => sum + (i.status === "ready" || i.status === "failed" ? 1 : i.status === "downloading" ? i.progress : 0), 0) / started
    : 0;
  const pending = entries.filter((x) => selected.has(x.id) && items[x.id]?.status !== "ready").length;

  return (
    <div className="space-y-4">
      <AnimatePresence mode="wait" initial={false}>
        {phase !== "list" && (
          <motion.form
            key="input"
            onSubmit={lookup}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="rounded-3xl border border-border bg-card p-5 shadow-xl shadow-primary/5"
          >
            <label htmlFor="playlist-url" className="mb-2 block text-sm font-medium">
              Playlist link
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="playlist-url"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError(null);
                  }}
                  placeholder="youtube.com/playlist?list=…"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-24 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={paste}
                  className="absolute right-0.5 top-1/2 flex h-11 -translate-y-1/2 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" /> Paste
                </button>
              </div>
              <Button type="submit" size="lg" className="h-12 min-w-40 shadow-lg shadow-primary/25" disabled={phase === "loading" || !url.trim()}>
                {phase === "loading" ? <Loader2 className="motion-safe:animate-spin" /> : wantsVideo ? <Film /> : <ListVideo />}
                {phase === "loading" ? "Reading list…" : wantsVideo ? "Get video" : "Get playlist"}
              </Button>
            </div>

            <AnimatePresence initial={false}>
              {playlist?.video && phase === "input" && (
                <motion.div
                  key="scope"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 inline-flex rounded-xl bg-secondary p-1" role="radiogroup" aria-label="Download">
                    {(["playlist", "video"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        role="radio"
                        aria-checked={scope === s}
                        onClick={() => setScope(s)}
                        onKeyDown={(e) => {
                          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                            e.preventDefault();
                            setScope(s === "playlist" ? "video" : "playlist");
                            (e.currentTarget.parentElement?.querySelector(`[aria-checked="false"]`) as HTMLElement | null)?.focus();
                          }
                        }}
                        tabIndex={scope === s ? 0 : -1}
                        className={cn(
                          "relative flex h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          scope === s ? "text-foreground" : "text-muted-foreground"
                        )}
                      >
                        {scope === s && <motion.span layoutId="scope-pill" className="absolute inset-0 rounded-lg bg-background shadow" transition={SPRING} />}
                        <span className="relative flex items-center gap-1.5">
                          {s === "playlist" ? <ListVideo className="h-4 w-4" /> : <Film className="h-4 w-4" />}
                          {s === "playlist" ? "Whole playlist" : "This video"}
                        </span>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
              {single && (
                <motion.p key="single" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mt-2 flex items-center gap-1 text-sm text-muted-foreground">
                  That&apos;s a single video.
                  <Link
                    href={`/tools/youtube-to-mp4?url=${encodeURIComponent(single.canonical)}`}
                    className="inline-flex min-h-11 items-center px-1 font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Download it
                  </Link>
                </motion.p>
              )}
            </AnimatePresence>

            {phase === "loading" && (
              <div className="mt-4 space-y-2" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex gap-3">
                    <div className="h-10 w-16 rounded-lg bg-secondary motion-safe:animate-pulse" />
                    <div className="flex-1 space-y-2 py-1">
                      <div className="h-3 w-4/5 rounded bg-secondary motion-safe:animate-pulse" />
                      <div className="h-3 w-1/5 rounded bg-secondary motion-safe:animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.form>
        )}

        {phase === "list" && list && (
          <motion.section
            key="list"
            aria-labelledby="playlist-title"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl shadow-primary/5"
          >
            {/* Header */}
            <div className="flex items-start gap-4 p-5">
              <div className="relative h-16 w-24 shrink-0 sm:h-20 sm:w-32">
                {entries.slice(0, 3).reverse().map((x, i, arr) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={x.id}
                    src={x.thumbnail}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="absolute inset-0 h-full w-full rounded-xl bg-secondary object-cover shadow-md ring-1 ring-border"
                    style={{ transform: `translate(${(arr.length - 1 - i) * -6}px, ${(arr.length - 1 - i) * -6}px)`, opacity: 1 - (arr.length - 1 - i) * 0.25 }}
                  />
                ))}
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="playlist-title" className="line-clamp-2 font-semibold leading-snug">
                  {list.title}
                </h2>
                <p className="mt-1 flex min-w-0 flex-wrap gap-x-1.5 text-sm text-muted-foreground">
                  {list.uploader && <span className="max-w-full truncate">{list.uploader} ·</span>}
                  <span className="shrink-0 tabular-nums">
                    {list.truncated ? `${entries.length} of ${list.count} videos` : `${entries.length} videos`}
                  </span>
                </p>
              </div>
            </div>

            {/* Format and quality */}
            <div className="flex flex-col gap-3 border-t border-border p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex self-start rounded-xl bg-secondary p-1" role="radiogroup" aria-label="Format">
                {(["mp4", "mp3"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    disabled={running}
                    onClick={() => setKind(k)}
                    className={cn(
                      "relative flex h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                      kind === k ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {kind === k && <motion.span layoutId="pl-kind-pill" className="absolute inset-0 rounded-lg bg-background shadow" transition={SPRING} />}
                    <span className="relative flex items-center gap-1.5">
                      {k === "mp4" ? <Film className="h-4 w-4" /> : <Music2 className="h-4 w-4" />}
                      {k.toUpperCase()}
                    </span>
                  </button>
                ))}
              </div>
              <AnimatePresence initial={false} mode="popLayout">
                {kind === "mp4" && (
                  <motion.div
                    key="quality"
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 8 }}
                    transition={{ duration: 0.25, ease: EASE }}
                    role="group"
                    aria-label="Quality"
                    className="grid grid-cols-4 gap-1.5"
                  >
                    {list.qualities.map((q) => (
                      <button
                        key={q.height}
                        type="button"
                        disabled={running}
                        aria-pressed={height === q.height && !q.locked}
                        aria-label={q.locked ? `${q.height}p (Pro)` : `${q.height}p`}
                        onClick={() => (q.locked ? setUpsell("quality") : setHeight(q.height))}
                        className={cn(
                          "relative h-11 rounded-xl border px-2.5 text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                          height === q.height && !q.locked
                            ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/25"
                            : "border-border bg-background hover:border-primary/50"
                        )}
                      >
                        {q.height}p
                        {q.locked && (
                          <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-fuchsia-500 text-white shadow">
                            <Crown className="h-3 w-3" />
                          </span>
                        )}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Toolbar: select all, export */}
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-1.5 sm:px-5">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 px-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-5 w-5 cursor-pointer rounded accent-primary"
                  checked={allSelected}
                  disabled={running}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && selected.size > 0;
                  }}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((x) => x.id)))}
                />
                <span>
                  All <span className="font-normal tabular-nums text-muted-foreground">({selected.size}/{entries.length})</span>
                </span>
              </label>
              <div role="group" aria-label="Export list" className="flex items-center gap-1">
                <span className="mr-1 hidden text-xs font-medium text-muted-foreground sm:inline">Export list</span>
                <Button type="button" variant="ghost" className="h-11 gap-1.5 px-3" onClick={() => exportList("csv")} aria-label="Export list as CSV">
                  <FileSpreadsheet /> CSV
                </Button>
                <Button type="button" variant="ghost" className="h-11 gap-1.5 px-3" onClick={() => exportList("txt")} aria-label="Export links as TXT">
                  <FileText /> TXT
                </Button>
              </div>
            </div>

            {/* Videos */}
            <ul className="max-h-[30rem] overflow-y-auto overscroll-contain border-t border-border" aria-label="Videos">
              {entries.map((x, i) => {
                const it = items[x.id] ?? { status: "idle" as Status, progress: 0 };
                return (
                  <motion.li
                    key={x.id}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: EASE, delay: Math.min(i, 14) * 0.03 }}
                    className={cn(
                      "flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0 sm:gap-3 sm:px-5",
                      it.status === "ready" && "bg-emerald-500/5"
                    )}
                    data-status={it.status}
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-1">
                      <span className="flex h-11 w-7 shrink-0 items-center justify-center">
                        <input
                          type="checkbox"
                          className="h-5 w-5 cursor-pointer rounded accent-primary"
                          checked={selected.has(x.id)}
                          disabled={running}
                          onChange={() => toggle(x.id)}
                        />
                      </span>
                      <span className="relative h-9 w-16 shrink-0 overflow-hidden rounded-md bg-secondary">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={x.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-sm leading-snug">{x.title}</span>
                        <span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
                          {formatDuration(x.duration)}
                          {it.status === "failed" && <span className="text-destructive"> · {it.error}</span>}
                        </span>
                        {it.status === "downloading" && (
                          <span className="relative mt-1 block h-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                            <ProgressFill value={it.progress} />
                          </span>
                        )}
                      </span>
                    </label>
                    <ItemAction item={it} title={x.title} onRetry={() => retry(x.id)} />
                  </motion.li>
                );
              })}
            </ul>

            {/* Footer: overall progress and actions */}
            <div className="border-t border-border p-5">
              <AnimatePresence initial={false}>
                {started > 0 && (
                  <motion.div key="overall" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
                    <div
                      className="relative mb-2.5 h-2.5 overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                      aria-label="Playlist progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(overall * 100)}
                    >
                      <motion.div
                        key="determinate"
                        className="h-full rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400"
                        animate={{ width: `${Math.max(2, overall * 100)}%` }}
                        transition={{ ease: "easeOut", duration: 0.5 }}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              <p aria-live="polite" className="mb-4 text-center text-sm tabular-nums text-muted-foreground empty:hidden" data-testid="playlist-summary">
                {started > 0 &&
                  [
                    `${ready} of ${started} ready`,
                    failed ? `${failed} failed` : null,
                    inFlight.length ? `${inFlight.length} to go` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
              </p>

              <AnimatePresence>
                {limitHit && (
                  <motion.button
                    type="button"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setUpsell("downloads")}
                    className="mb-4 flex min-h-11 w-full items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3.5 py-2.5 text-left text-sm text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-amber-950/30 dark:text-amber-200"
                  >
                    <Crown className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="flex-1">Daily limit reached.</span>
                    <span className="font-semibold underline">Get more</span>
                  </motion.button>
                )}
              </AnimatePresence>

              <div className="flex flex-col gap-2 sm:flex-row">
                {running ? (
                  <Button size="lg" variant="secondary" className="flex-1" onClick={stop}>
                    <Square className="fill-current" /> Stop
                  </Button>
                ) : (
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} tabIndex={-1} className="flex-1">
                    <Button size="lg" className="w-full shadow-lg shadow-primary/25" onClick={downloadSelected} disabled={!pending || limitHit}>
                      <Download />
                      {pending === entries.length ? "Download all" : pending ? `Download ${pending}` : "Download"}
                      <span className="text-sm font-normal">· {kind === "mp3" ? "MP3" : `${height}p`}</span>
                    </Button>
                  </motion.div>
                )}
                <Button size="lg" variant="outline" onClick={reset}>
                  <RotateCcw /> Different link
                </Button>
              </div>
            </div>
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.p
            role="alert"
            data-testid="tool-error"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-start gap-2 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
          </motion.p>
        )}
      </AnimatePresence>

      <p className="text-center text-xs text-muted-foreground">Only download videos you have permission to use.</p>

      {upsell && (
        <UpgradeDialog
          open
          onOpenChange={(o) => !o && setUpsell(null)}
          reason={upsell}
          tier={tier}
          returnTo={list ? `${pathname}?url=${encodeURIComponent(list.url)}` : pathname}
        />
      )}
    </div>
  );
}

/** Right-hand slot of a row: status, Save once ready, Retry on failure. */
function ItemAction({ item, title, onRetry }: { item: Item; title: string; onRetry: () => void }) {
  const box = "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl";
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={item.status}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        transition={{ duration: 0.18 }}
        className="shrink-0"
      >
        {item.status === "queued" && (
          <span className={cn(box, "text-muted-foreground")} title="Queued">
            <Clock className="h-4 w-4" aria-hidden />
            <span className="sr-only">Queued</span>
          </span>
        )}
        {item.status === "downloading" && (
          <span className={cn(box, "text-xs font-semibold tabular-nums text-primary")}>
            {item.progress > 0.02 ? `${Math.round(item.progress * 100)}%` : <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />}
            <span className="sr-only">Downloading</span>
          </span>
        )}
        {item.status === "ready" && item.href && (
          <a
            href={item.href}
            rel="noopener"
            aria-label={`Save ${title}`}
            title="Save"
            className={cn(box, "bg-emerald-500 text-white shadow-md shadow-emerald-500/30 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2")}
          >
            <motion.span initial={{ y: -6, scale: 0 }} animate={{ y: 0, scale: 1 }} transition={SPRING}>
              <Download className="h-5 w-5" aria-hidden />
            </motion.span>
          </a>
        )}
        {item.status === "failed" && (
          <button
            type="button"
            onClick={onRetry}
            aria-label={`Retry ${title}`}
            title="Retry"
            className={cn(box, "border border-destructive/40 text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
