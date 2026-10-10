"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  ClipboardPaste,
  Crown,
  Download,
  Film,
  Link2,
  ListVideo,
  Loader2,
  Music2,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EASE, SPRING, SparkleBurst } from "@/components/motion/primitives";
import { UpgradeDialog, type UpsellReason } from "@/components/upsell/Upsell";
import { parseMediaUrl, parsePlaylistUrl, PLATFORM_LABEL, type MediaKind, type MediaPlatform } from "@/lib/media";
import type { Tier } from "@/lib/limits";
import { cn, formatBytes } from "@/lib/utils";
import { trackDownload, trackToolUsed } from "@/lib/analytics";

export interface MediaToolConfig {
  platform: MediaPlatform;
  kind: MediaKind;
  defaultHeight?: number;
}

interface Info {
  platform: MediaPlatform;
  title: string;
  uploader?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
  hasAudio?: boolean;
  qualities: { height: number; available: boolean; locked: boolean }[];
  /** The link this preview was made from; downloads always use it. */
  url: string;
}

type Phase = "input" | "loading" | "preview" | "working" | "ready";

interface SavedFile {
  href: string;
  name: string;
  size?: number | null;
  /** blob: kept in this tab. remote: a link that can expire (worker job, X stream). */
  source: "blob" | "remote";
}

const STAGES: Record<string, string> = {
  queued: "Getting ready…",
  downloading: "Downloading…",
  processing: "Merging audio and video…",
  fetching: "Fetching the video…",
  preparing: "Preparing converter…",
  converting: "Converting to MP3…",
  ready: "Ready",
};

/** Give up on a stuck worker job rather than spinning forever. */
const POLL_DEADLINE_MS = 20 * 60 * 1000;
const POLL_MAX_FAILURES = 6;
/** Larger X files are saved by the browser directly instead of through memory. */
const MAX_IN_MEMORY = 1024 ** 3;

/** An error whose message is ours and safe to show as is. */
class Shown extends Error {}

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

/** Our own links (and blobs) take a download name, so an error page never replaces the tool. */
const sameOrigin = (href: string) => href.startsWith("blob:") || href.startsWith("/");

function saveAs(href: string, name?: string) {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Reads a response into memory, reporting progress when the size is known. */
async function readWithProgress(res: Response, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) onProgress(Math.min(1, received / total));
  }
  if (total && received < total) throw new Error("incomplete");
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Gives a YouTube download back when its job failed or never ran (the server checks). */
function refund(token: string) {
  void fetch("/api/media/refund", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    keepalive: true,
  }).catch(() => null);
}

function duration(s?: number | null) {
  if (!s) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Progress fill: determinate once there's a number; a sweep (or, with reduced motion, a still bar) before. */
export function ProgressFill({ value }: { value: number }) {
  const reduce = useReducedMotion();
  const gradient = "rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400";
  if (value > 0.02) {
    return (
      <motion.span
        key="determinate"
        className={cn("block h-full", gradient)}
        initial={false}
        animate={{ width: `${Math.max(4, value * 100)}%` }}
        transition={{ ease: "easeOut", duration: 0.5 }}
      />
    );
  }
  if (reduce) return <span key="still" className="block h-full w-full rounded-full bg-primary/35" />;
  return (
    <motion.span
      key="sweep"
      className="absolute inset-y-0 left-0 block w-1/3 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent"
      animate={{ x: ["-100%", "300%"] }}
      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

export function MediaDownloader({ config, tier }: { config: MediaToolConfig; tier: Tier }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const [url, setUrl] = useState(() => params.get("url")?.trim() ?? "");
  const [phase, setPhase] = useState<Phase>("input");
  const [info, setInfo] = useState<Info | null>(null);
  const [kind, setKind] = useState<MediaKind>(config.kind);
  const [height, setHeight] = useState<number>(config.defaultHeight ?? 720);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ value: number; stage: string }>({ value: 0, stage: "queued" });
  const [file, setFile] = useState<SavedFile | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [wantedLocked, setWantedLocked] = useState(false);
  /** Set after a 429: the day's downloads are spent. */
  const [limit, setLimit] = useState<{ upgrade: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const blobUrl = useRef<string | null>(null);
  const alive = useRef(true);
  const lookupSeq = useRef(0);
  /** The download in progress: aborting it cancels fetches, polling and the converter. */
  const op = useRef<AbortController | null>(null);
  const job = useRef<{ workerUrl: string; id: string; token: string } | null>(null);
  /** Where keyboard focus goes once the next phase has rendered. */
  const focusNext = useRef<"url" | "download" | "progress" | "ready" | null>(null);
  const focusRef = (key: NonNullable<typeof focusNext.current>) => (el: HTMLElement | null) => {
    if (el && focusNext.current === key) {
      focusNext.current = null;
      // Show the ring only to keyboard users, like a click would.
      el.focus({ preventScroll: true, focusVisible: keyboard.current } as FocusOptions);
    }
  };
  const keyboard = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key === "Enter" || e.key === " ") keyboard.current = true;
    };
    const onPointer = () => (keyboard.current = false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, []);

  const stopPolling = () => {
    if (poll.current) clearTimeout(poll.current);
    poll.current = null;
  };
  const releaseBlob = () => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      op.current?.abort();
      stopPolling();
      releaseBlob();
    };
  }, []);

  const detected = url ? parseMediaUrl(url) : null;
  const playlist = url ? parsePlaylistUrl(url) : null;

  // A ?url= link (e.g. from the homepage) looks the video up straight away.
  const autoLookup = useRef(false);
  useEffect(() => {
    if (autoLookup.current) return;
    autoLookup.current = true;
    if (detected) void lookup(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keeps the address bar in step, so refresh and sharing show the same video. */
  function syncAddress(link: string | null) {
    const next = link ? `${pathname}?url=${encodeURIComponent(link)}` : pathname;
    if (window.location.pathname + window.location.search !== next) window.history.replaceState(null, "", next);
  }

  const advance = (value: number, stage: string) =>
    setProgress((p) => ({ value: Math.max(p.value, Math.min(1, value)), stage }));

  /** `auto`: from a ?url= link on arrival, so focus stays where the page put it. */
  async function lookup(e?: React.FormEvent, auto = false) {
    e?.preventDefault();
    if (phase === "loading") return;
    setError(null);
    const target = url.trim();
    const parsed = parseMediaUrl(target);
    if (!parsed) {
      // A playlist link is offered the playlist tool instead (see below the input).
      if (!playlist) setError(`Paste a ${PLATFORM_LABEL[config.platform]} video link.`);
      return;
    }
    const seq = ++lookupSeq.current;
    setPhase("loading");
    const res = await fetch("/api/media/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    // A newer lookup, or "Different link", wins over this answer.
    if (!alive.current || seq !== lookupSeq.current) return;
    if (!res?.ok) {
      setError(data?.error ?? (res ? "Couldn't read that link." : "You're offline. Check your connection."));
      if (!auto) focusNext.current = "url";
      setPhase("input");
      return;
    }
    setInfo({ ...data, url: target });
    setNote(null);
    syncAddress(parsed.canonical);
    if (!auto) focusNext.current = "download";
    if (kind === "mp3" && data.hasAudio === false) {
      setKind("mp4");
      setNote(data.platform === "x" ? "This is a GIF, so it has no sound. It downloads as MP4." : "This video has no sound. It downloads as MP4.");
    }
    // Start on the requested quality if possible, else the best unlocked one.
    const usable = (data.qualities as Info["qualities"]).filter((q) => q.available);
    const wanted = config.defaultHeight ?? 720;
    const preferred = usable.find((q) => q.height === wanted && !q.locked);
    // On the 1080p page, explain why a free user starts at 720p.
    setWantedLocked(usable.some((q) => q.height === wanted && q.locked) && usable.some((q) => !q.locked));
    const best = [...usable].reverse().find((q) => !q.locked);
    setHeight((preferred ?? best ?? usable[0])?.height ?? 360);
    setPhase("preview");
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setError("Clipboard blocked. Paste with Ctrl+V.");
    }
  }

  function pickQuality(q: Info["qualities"][number]) {
    if (!q.available) return;
    if (q.locked) {
      setUpsell("quality");
      return;
    }
    setHeight(q.height);
  }

  /** Back to the preview with a message; focus returns to the Download button. */
  function fail(message: string) {
    stopPolling();
    op.current = null;
    job.current = null;
    if (!alive.current) return;
    setError(message);
    focusNext.current = "download";
    setPhase("preview");
  }

  async function start() {
    if (busy.current || !info) return;
    busy.current = true;
    setStarting(true);
    setError(null);
    try {
      await begin(info.url, false);
    } finally {
      busy.current = false;
      if (alive.current) setStarting(false);
    }
  }

  async function begin(link: string, retried: boolean) {
    const res = await fetch("/api/media/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: link, kind, height: kind === "mp4" ? height : undefined }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (!alive.current) return;
    if (!res?.ok) {
      if (res?.status === 429) {
        setLimit({ upgrade: !!data?.upgrade });
        if (data?.upgrade) setUpsell("downloads");
        else setError(data?.error ?? "You've used today's downloads.");
      } else if (data?.upgrade) setUpsell(data.reason === "quality" ? "quality" : "downloads");
      else setError(data?.error ?? (res ? "Couldn't start the download." : "You're offline. Check your connection."));
      return;
    }
    const ctl = new AbortController();
    op.current = ctl;
    setProgress({ value: 0, stage: data.mode === "worker" ? "queued" : data.mode === "convert" ? "fetching" : "downloading" });
    focusNext.current = "progress";
    setPhase("working");
    if (data.mode === "direct") return await downloadX(data.href, data.filename, ctl.signal);
    if (data.mode === "convert") return await convertToMp3(data.href, data.filename, ctl.signal);
    await runWorkerJob(data.workerUrl, data.token, ctl.signal, retried);
  }

  function finish(next: SavedFile) {
    op.current = null;
    job.current = null;
    setFile(next);
    focusNext.current = "ready";
    setPhase("ready");
    saveAs(next.href, sameOrigin(next.href) ? next.name : undefined);
    trackToolUsed();
    trackDownload(next.name);
  }

  /** Fetches one of our own file links; a JSON error body becomes the message. */
  async function fetchFile(href: string, signal: AbortSignal) {
    let res: Response;
    try {
      res = await fetch(href, { signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new Shown("X didn't send the video. Try again.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Shown(body?.error ?? "X didn't send the video. Try again.");
    }
    return res;
  }

  /** X video: our own origin streams it; it's read here so a broken stream is never reported as saved. */
  async function downloadX(href: string, name: string, signal: AbortSignal) {
    try {
      const res = await fetchFile(href, signal);
      const size = Number(res.headers.get("content-length")) || 0;
      if (size > MAX_IN_MEMORY) {
        // Too big to hold in a tab: the browser saves it straight from our origin.
        await res.body?.cancel();
        return finish({ href, name, size, source: "remote" });
      }
      const bytes = await readWithProgress(res, (f) => advance(f, "downloading")).catch((err) => {
        throw isAbort(err) ? err : new Shown("X stopped sending the video. Try again.");
      });
      if (!alive.current || signal.aborted) return;
      releaseBlob();
      blobUrl.current = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "video/mp4" }));
      finish({ href: blobUrl.current, name, size: bytes.byteLength, source: "blob" });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      fail(err instanceof Shown ? err.message : "X stopped sending the video. Try again.");
    }
  }

  /** X audio: fetch the smallest MP4 and convert it in this tab, loading the converter meanwhile. */
  async function convertToMp3(href: string, name: string, signal: AbortSignal) {
    let converterReady = false;
    const converter = import("@/lib/mp3").then(async (m) => {
      const c = await m.loadMp3Converter(signal);
      converterReady = true;
      return c;
    });
    converter.catch(() => null);
    let mp4: Uint8Array;
    try {
      const res = await fetchFile(href, signal);
      mp4 = await readWithProgress(res, (f) => advance(f * 0.4, "fetching")).catch((err) => {
        throw isAbort(err) ? err : new Shown("X stopped sending the video. Try again.");
      });
    } catch (err) {
      void converter.then((c) => c.dispose(), () => null);
      if (isAbort(err) || signal.aborted) return;
      return fail(err instanceof Shown ? err.message : "X stopped sending the video. Try again.");
    }
    try {
      if (!converterReady) advance(0.4, "preparing");
      const c = await converter;
      advance(0.4, "converting");
      const { ConvertError } = await import("@/lib/mp3");
      const mp3 = await c.convert(mp4, (f) => advance(0.4 + f * 0.6, "converting")).catch((err) => {
        throw err instanceof ConvertError ? new Shown(err.message) : err;
      });
      if (!alive.current || signal.aborted) return;
      releaseBlob();
      blobUrl.current = URL.createObjectURL(new Blob([mp3 as BlobPart], { type: "audio/mpeg" }));
      finish({ href: blobUrl.current, name, size: mp3.byteLength, source: "blob" });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      fail(err instanceof Shown ? err.message : "Converting to MP3 failed in this browser. Download the MP4 instead.");
    }
  }

  /** YouTube: the media worker downloads and merges; we poll until the file is ready. */
  async function runWorkerJob(workerUrl: string, token: string, signal: AbortSignal, retried: boolean) {
    // Not aborted on Cancel: the answer is needed to stop the job it may have started.
    const res = await fetch(`${workerUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    const created = await res?.json().catch(() => null);
    if (!alive.current || signal.aborted) {
      if (created?.id) job.current = { workerUrl, id: created.id, token };
      if (job.current) cancelJob();
      else refund(token);
      return;
    }
    if (!res?.ok || !created?.id) {
      refund(token);
      // A grant that went stale on the way (a slow or sleeping worker): get a fresh one once.
      if (created?.code === "expired" && !retried) return begin(info?.url ?? url, true);
      return fail(created?.error ?? "The download server isn't responding. Try again in a minute.");
    }
    job.current = { workerUrl, id: created.id, token };

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let failures = 0;
    const tick = async () => {
      poll.current = null;
      if (!alive.current || signal.aborted) return;
      if (Date.now() > deadline) {
        cancelJob();
        return fail("This download is taking too long. Try a lower quality.");
      }
      const r = await fetch(`${workerUrl}/jobs/${created.id}`, { cache: "no-store", signal }).catch(() => null);
      const s = await r?.json().catch(() => null);
      if (!alive.current || signal.aborted) return;
      if (!r || !s) {
        if (++failures >= POLL_MAX_FAILURES) {
          refund(token);
          return fail("Lost contact with the download server. Try again.");
        }
      } else if (!r.ok || s.status === "error") {
        refund(token);
        return fail(s.error ?? "Download failed.");
      } else {
        failures = 0;
        advance(Number(s.progress) || 0, s.stage ?? "downloading");
        if (s.status === "ready") {
          return finish({ href: `${workerUrl}/jobs/${created.id}/file`, name: s.filename, size: s.size, source: "remote" });
        }
      }
      poll.current = setTimeout(tick, 1000);
    };
    poll.current = setTimeout(tick, 800);
  }

  /** Stops the worker's job (freeing its slot) and gives the download back. */
  function cancelJob() {
    const j = job.current;
    job.current = null;
    if (!j) return;
    void fetch(`${j.workerUrl}/jobs/${j.id}`, { method: "DELETE", keepalive: true })
      .catch(() => null)
      .finally(() => refund(j.token));
  }

  function cancel() {
    op.current?.abort();
    op.current = null;
    stopPolling();
    cancelJob();
    setError(null);
    focusNext.current = "download";
    setPhase("preview");
  }

  /** Saves the file again; a link that has expired starts a fresh download instead. */
  async function saveAgain() {
    if (!file) return;
    if (file.source === "blob") {
      trackDownload(file.name);
      return saveAs(file.href, file.name);
    }
    const ok = await fetch(file.href, { method: "HEAD", cache: "no-store" })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      trackDownload(file.name);
      return saveAs(file.href, sameOrigin(file.href) ? file.name : undefined);
    }
    focusNext.current = "progress";
    await start();
  }

  function reset() {
    lookupSeq.current++;
    op.current?.abort();
    op.current = null;
    stopPolling();
    cancelJob();
    releaseBlob();
    setNote(null);
    setUrl("");
    setInfo(null);
    setFile(null);
    setError(null);
    syncAddress(null);
    focusNext.current = "url";
    setPhase("input");
  }

  const platformName = PLATFORM_LABEL[config.platform];
  const loading = phase === "loading";
  const available = info?.qualities.filter((q) => q.available) ?? [];
  // e.g. an X post that only exists in 1080p, for a free user.
  const allLocked = kind === "mp4" && available.length > 0 && available.every((q) => q.locked);
  const lockedOnly = allLocked ? available[available.length - 1].height : null;
  const returnTo = info ? `${pathname}?url=${encodeURIComponent(info.url)}` : pathname;
  const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  const radioKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next: MediaKind = kind === "mp4" ? "mp3" : "mp4";
    if (next === "mp3" && info?.hasAudio === false) return;
    setKind(next);
    setNote(null);
    (e.currentTarget.parentElement?.querySelector(`[data-kind="${next}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div className="space-y-4">
      <AnimatePresence mode="wait" initial={false}>
        {(phase === "input" || phase === "loading") && (
          <motion.form
            key="input"
            onSubmit={lookup}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="rounded-3xl border border-border bg-card p-5 shadow-xl shadow-primary/5"
            aria-busy={loading}
          >
            <label htmlFor="media-url" className="mb-2 block text-sm font-medium">
              {platformName} link
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="media-url"
                  ref={focusRef("url")}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  readOnly={loading}
                  placeholder={config.platform === "youtube" ? "youtu.be/…" : "x.com/user/status/…"}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-24 text-sm outline-none focus:ring-2 focus:ring-ring read-only:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={paste}
                  disabled={loading}
                  className={cn(
                    "absolute right-0.5 top-1/2 flex h-11 -translate-y-1/2 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
                    focusRing
                  )}
                >
                  <ClipboardPaste className="h-3.5 w-3.5" /> Paste
                </button>
              </div>
              <Button type="submit" size="lg" className="h-12 min-w-36 shadow-lg shadow-primary/25" disabled={loading || !url.trim()}>
                {loading ? <Loader2 className="motion-safe:animate-spin" /> : <Download />}
                {loading ? "Reading link…" : "Get video"}
              </Button>
            </div>
            <AnimatePresence>
              {playlist && (
                <motion.div
                  key="playlist"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-3 flex items-center gap-2 text-sm"
                >
                  <span className="text-muted-foreground">{detected ? "Part of a playlist." : "That's a playlist."}</span>
                  <Link
                    href={`/tools/youtube-playlist?url=${encodeURIComponent(playlist.canonical)}`}
                    className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-semibold text-primary hover:underline", focusRing)}
                  >
                    <ListVideo className="h-4 w-4" /> Whole playlist
                  </Link>
                </motion.div>
              )}
              {detected && detected.platform !== config.platform && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 text-xs text-muted-foreground">
                  That&apos;s a {PLATFORM_LABEL[detected.platform]} link — it works here too.
                </motion.p>
              )}
            </AnimatePresence>
            {loading && (
              <div className="mt-4 flex gap-3" aria-hidden>
                <div className="h-16 w-28 shrink-0 rounded-xl bg-secondary motion-safe:animate-pulse sm:h-20 sm:w-36" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3 w-4/5 rounded bg-secondary motion-safe:animate-pulse" />
                  <div className="h-3 w-2/5 rounded bg-secondary motion-safe:animate-pulse" />
                </div>
              </div>
            )}
          </motion.form>
        )}

        {info && (phase === "preview" || phase === "working") && (
          <motion.div
            key="preview"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="overflow-hidden rounded-3xl border border-border bg-card shadow-xl shadow-primary/5"
          >
            <div className="flex gap-3 p-4 sm:gap-4 sm:p-5">
              <div className="relative h-16 w-28 shrink-0 overflow-hidden rounded-xl bg-secondary sm:h-24 sm:w-40">
                {info.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={info.thumbnail} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                )}
                {duration(info.duration) && (
                  <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white sm:bottom-1.5 sm:right-1.5">
                    {duration(info.duration)}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 break-words font-semibold leading-snug" data-testid="media-title">
                  {info.title}
                </p>
                {info.uploader && <p className="mt-1 truncate text-sm text-muted-foreground">{info.uploader}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{PLATFORM_LABEL[info.platform]}</p>
              </div>
            </div>

            {phase === "preview" ? (
              <div className="space-y-4 border-t border-border p-4 sm:p-5">
                <div className="inline-flex rounded-xl bg-secondary p-1" role="radiogroup" aria-label="Format">
                  {(["mp4", "mp3"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      data-kind={k}
                      aria-checked={kind === k}
                      tabIndex={kind === k ? 0 : -1}
                      disabled={k === "mp3" && info.hasAudio === false}
                      onClick={() => {
                        setKind(k);
                        setNote(null);
                      }}
                      onKeyDown={radioKeys}
                      className={cn(
                        "relative flex h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-40",
                        focusRing,
                        kind === k ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {kind === k && (
                        <motion.span layoutId="kind-pill" className="absolute inset-0 rounded-lg bg-background shadow" transition={SPRING} />
                      )}
                      <span className="relative flex items-center gap-1.5">
                        {k === "mp4" ? <Film className="h-4 w-4" /> : <Music2 className="h-4 w-4" />}
                        {k.toUpperCase()} {k === "mp4" ? "video" : "audio"}
                      </span>
                    </button>
                  ))}
                </div>

                {kind === "mp4" && (
                  <div role="group" aria-labelledby="quality-label">
                    <p id="quality-label" className="mb-2 text-sm font-medium">
                      Quality
                    </p>
                    <div className="grid grid-cols-4 gap-2">
                      {info.qualities.map((q) => (
                        <motion.button
                          key={q.height}
                          type="button"
                          whileTap={q.available ? { scale: 0.95 } : undefined}
                          onClick={() => pickQuality(q)}
                          disabled={!q.available}
                          aria-pressed={height === q.height && !q.locked}
                          aria-label={q.locked && q.available ? `${q.height}p (Pro)` : undefined}
                          title={!q.available ? "Not available for this video" : q.locked ? "Pro" : undefined}
                          className={cn(
                            "relative h-11 rounded-xl border px-2 text-sm font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                            focusRing,
                            height === q.height && !q.locked
                              ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/25"
                              : "border-border bg-background hover:border-primary/50"
                          )}
                        >
                          {q.height}p
                          {q.locked && q.available && (
                            <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-fuchsia-500 text-white shadow">
                              <Crown className="h-3 w-3" />
                            </span>
                          )}
                        </motion.button>
                      ))}
                    </div>
                  </div>
                )}

                {note && <p className="text-sm text-muted-foreground">{note}</p>}

                {kind === "mp4" && (wantedLocked || allLocked) && (
                  <motion.button
                    type="button"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => setUpsell("quality")}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3.5 py-2.5 text-left text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
                      focusRing
                    )}
                  >
                    <Crown className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="flex-1">{allLocked ? `Only in ${lockedOnly}p, a Pro quality.` : `1080p is Pro. Using ${height}p.`}</span>
                    <span className="font-semibold underline">Unlock</span>
                  </motion.button>
                )}

                <AnimatePresence>
                  {limit?.upgrade && (
                    <motion.button
                      type="button"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      onClick={() => setUpsell("downloads")}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3.5 py-2.5 text-left text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200",
                        focusRing
                      )}
                    >
                      <Crown className="h-4 w-4 shrink-0 text-amber-500" />
                      <span className="flex-1">Daily limit reached.</span>
                      <span className="font-semibold underline">Get more</span>
                    </motion.button>
                  )}
                </AnimatePresence>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} tabIndex={-1} className="flex-1">
                    {allLocked && info.hasAudio !== false ? (
                      <Button
                        ref={focusRef("download")}
                        size="lg"
                        className="w-full shadow-lg shadow-primary/25"
                        onClick={() => {
                          setKind("mp3");
                          setNote(null);
                        }}
                      >
                        <Music2 /> Get MP3 instead
                      </Button>
                    ) : (
                      <Button
                        ref={focusRef("download")}
                        size="lg"
                        className="w-full shadow-lg shadow-primary/25"
                        onClick={allLocked ? () => setUpsell("quality") : start}
                        disabled={starting || !!limit}
                      >
                        {starting ? <Loader2 className="motion-safe:animate-spin" /> : <Download />} Download{" "}
                        {kind === "mp3" ? "MP3" : `MP4 · ${height}p`}
                      </Button>
                    )}
                  </motion.div>
                  <Button size="lg" variant="outline" onClick={reset}>
                    <RotateCcw /> Different link
                  </Button>
                </div>
              </div>
            ) : (
              <div ref={focusRef("progress")} tabIndex={-1} className="border-t border-border p-4 outline-none sm:p-5">
                <div
                  className="relative h-3 overflow-hidden rounded-full bg-secondary"
                  role="progressbar"
                  aria-label="Download progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.value > 0.02 ? Math.round(progress.value * 100) : undefined}
                >
                  <ProgressFill value={progress.value} />
                </div>
                <p className="mt-2 text-center text-sm text-muted-foreground" aria-hidden>
                  {kind === "mp3" && progress.stage === "processing" ? STAGES.converting : (STAGES[progress.stage] ?? "Working…")}
                  {progress.value > 0.02 && <span className="ml-1 tabular-nums">{Math.round(progress.value * 100)}%</span>}
                </p>
                {/* Announces stage changes only, not every percent. */}
                <p className="sr-only" aria-live="polite">
                  {kind === "mp3" && progress.stage === "processing" ? STAGES.converting : (STAGES[progress.stage] ?? "Working…")}
                </p>
                <div className="mt-2 flex justify-center">
                  <Button variant="ghost" className="h-11 text-muted-foreground" onClick={cancel}>
                    <X /> Cancel
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        )}

        {phase === "ready" && file && (
          <motion.div
            key="ready"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="relative overflow-hidden rounded-3xl border border-border bg-card p-8 text-center shadow-xl shadow-primary/5"
          >
            <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
              <SparkleBurst />
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={SPRING}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
              >
                {kind === "mp3" ? <Music2 className="h-8 w-8" /> : <Film className="h-8 w-8" />}
              </motion.div>
            </div>
            <h2 ref={focusRef("ready")} tabIndex={-1} className="mt-5 text-2xl font-bold outline-none">
              Your download has started
            </h2>
            <p className="mx-auto mt-1 max-w-sm truncate text-sm text-muted-foreground">
              {file.name}
              {file.size ? ` · ${formatBytes(file.size)}` : ""}
            </p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <Button size="lg" variant="outline" onClick={saveAgain} disabled={starting}>
                {starting ? <Loader2 className="motion-safe:animate-spin" /> : <Download />} Download again
              </Button>
              <Button size="lg" onClick={reset}>
                <RotateCcw /> Another video
              </Button>
            </div>
          </motion.div>
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

      {upsell && <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo={returnTo} />}
    </div>
  );
}
