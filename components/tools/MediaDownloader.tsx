"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  DUR,
  EASE_OUT,
  ENTER_T,
  EXIT,
  EXIT_T,
  FADE_EXIT,
  InlineError,
  NOTICE_T,
  PillLabel,
  SPRING_LAYOUT,
  SuccessBadge,
} from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent } from "@/components/motion/Progress";
import { settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, type UpsellReason } from "@/components/upsell/Upsell";
import {
  linkIn,
  parseMediaUrl,
  parsePlaylistUrl,
  PLATFORM_LABEL,
  PLATFORM_PLACEHOLDER,
  YOUTUBE_ENABLED,
  type MediaKind,
  type MediaPlatform,
} from "@/lib/media";
import { pasteBlockedMessage } from "@/lib/clipboard";
import type { Tier } from "@/lib/limits";
import { cn, formatBytes } from "@/lib/utils";
import { trackDownload, trackToolUsed } from "@/lib/analytics";
import { canEncodeH264, MAX_IN_MEMORY, shortBytes } from "@/lib/video-quality";

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
  /** size: bytes of that quality's file (exact or estimated); smaller: about what "Smaller file" makes of it. */
  qualities: { height: number; available: boolean; locked: boolean; size?: number; exact?: boolean; smaller?: number }[];
  /** The link this preview was made from; downloads always use it. */
  url: string;
}

type Phase = "input" | "loading" | "preview" | "working" | "ready";

interface SavedFile {
  href: string;
  name: string;
  size?: number | null;
  /** The download's size before "Smaller file" re-encoded it. */
  was?: number;
  note?: string;
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
  shrinking: "Making it smaller…",
  ready: "Ready",
};

/** "Smaller file" is remembered per browser. */
const SMALLER_KEY = "pw.media.smaller";
function readSmaller(): boolean {
  try {
    return localStorage.getItem(SMALLER_KEY) === "1";
  } catch {
    return false;
  }
}
function writeSmaller(on: boolean) {
  try {
    localStorage.setItem(SMALLER_KEY, on ? "1" : "0");
  } catch {}
}

/** Give up on a stuck worker job rather than spinning forever. */
const POLL_DEADLINE_MS = 20 * 60 * 1000;
const POLL_MAX_FAILURES = 6;

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

/**
 * The preview card's height with a two-line title and no notes (its buttons
 * stack below sm), measured at 360–1440px.
 */
function previewHeight() {
  return window.innerWidth < 640 ? 407 : 379;
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
  /** "Smaller file": re-encode in this tab. Offered only where the browser can make H.264. */
  const [canShrink, setCanShrink] = useState(false);
  const [smaller, setSmaller] = useState(false);
  useEffect(() => {
    setSmaller(readSmaller());
    let live = true;
    void canEncodeH264().then((ok) => live && setCanShrink(ok));
    return () => {
      live = false;
    };
  }, []);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const blobUrl = useRef<string | null>(null);
  const alive = useRef(true);
  const lookupSeq = useRef(0);
  /** Set while a silent post has the format on MP4 instead of MP3, so the next post with sound goes back. */
  const autoMp4 = useRef(false);
  /** The download in progress: aborting it cancels fetches, polling and the converter. */
  const op = useRef<AbortController | null>(null);
  const job = useRef<{ workerUrl: string; id: string; token: string } | null>(null);
  /** Where keyboard focus goes once the next phase has rendered. */
  const { next: focusNext, focusRef } = useFocusNext<"url" | "download" | "progress" | "ready">();
  /**
   * Reserved at the Download click: the card keeps its height while the
   * options give way to progress and progress gives way to the result, so
   * nothing below it moves when the download finishes on its own.
   */
  const flow = useHeightLock<HTMLDivElement>();
  const slot = useHeightLock<HTMLDivElement>();
  /** Set once a quality is picked here, so the chosen chip's label animates from then on. */
  const qualityPicked = useRef(false);

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

  // Share-sheet text around the link is fine: only the link is read.
  const detected = url ? parseMediaUrl(linkIn(url)) : null;
  const playlist = url && YOUTUBE_ENABLED ? parsePlaylistUrl(linkIn(url)) : null;

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
    const target = linkIn(url);
    const parsed = parseMediaUrl(target);
    if (!parsed) {
      // A playlist link is offered the playlist tool instead (see below the input).
      if (!playlist) setError(`Paste a ${PLATFORM_LABEL[config.platform]} video link.`);
      return;
    }
    const seq = ++lookupSeq.current;
    setPhase("loading");
    // Room for the preview, taken now while the click explains it: the
    // answer can take a second or two, and the page below shouldn't move then.
    if (!auto) flow.reserve(previewHeight());
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
      flow.release();
      setPhase("input");
      return;
    }
    setInfo({ ...data, url: target });
    setNote(null);
    syncAddress(parsed.canonical);
    if (!auto) focusNext.current = "download";
    if (data.hasAudio === false) {
      if (kind === "mp3" || autoMp4.current) {
        autoMp4.current = true;
        setKind("mp4");
        setNote(data.platform === "x" ? "This is a GIF, so it has no sound. It downloads as MP4." : "This video has no sound. It downloads as MP4.");
      }
    } else if (autoMp4.current) {
      autoMp4.current = false;
      setKind("mp3");
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
      if (text) setUrl(linkIn(text));
    } catch {
      setError(pasteBlockedMessage());
    }
  }

  function pickQuality(q: Info["qualities"][number]) {
    if (!q.available) return;
    if (q.locked) {
      setUpsell("quality");
      return;
    }
    qualityPicked.current = true;
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
    flow.lock();
    slot.lock();
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
      // The button was disabled while starting; give focus back to it.
      focusNext.current = "download";
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
    // Direct files come from the post's platform; their errors name it.
    const from = PLATFORM_LABEL[info?.platform ?? config.platform];
    if (data.mode === "direct") return await downloadX(data.href, data.filename, from, ctl.signal, shrinkOffered && smaller);
    if (data.mode === "convert") return await convertToMp3(data.href, data.filename, from, ctl.signal);
    await runWorkerJob(data.workerUrl, data.token, ctl.signal, retried);
  }

  function finish(next: SavedFile) {
    op.current = null;
    job.current = null;
    setFile(next);
    focusNext.current = "ready";
    // The page settles while the progress leaves, so the card lands in view.
    settleSlot(flow.ref.current);
    setPhase("ready");
    saveAs(next.href, sameOrigin(next.href) ? next.name : undefined);
    trackToolUsed();
    trackDownload(next.name);
  }

  /** Fetches one of our own file links; a JSON error body becomes the message. */
  async function fetchFile(href: string, from: string, signal: AbortSignal) {
    let res: Response;
    try {
      res = await fetch(href, { signal });
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new Shown(`${from} didn't send the video. Try again.`);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Shown(body?.error ?? `${from} didn't send the video. Try again.`);
    }
    return res;
  }

  /**
   * X, TikTok, Instagram video: our own origin streams it; it's read here so a
   * broken stream is never reported as saved. With `shrink`, it's then
   * re-encoded in this tab (lib/video-compress.ts), which keeps the original
   * when that wouldn't pay off or can't be done here.
   */
  async function downloadX(href: string, name: string, from: string, signal: AbortSignal, shrink = false) {
    const stopped = `${from} stopped sending the video. Try again.`;
    try {
      const res = await fetchFile(href, from, signal);
      const size = Number(res.headers.get("content-length")) || 0;
      if (size > MAX_IN_MEMORY) {
        // Too big to hold in a tab: the browser saves it straight from our origin.
        await res.body?.cancel();
        const note = shrink ? "Too large to make smaller in the browser, so this is the original." : undefined;
        return finish({ href, name, size, note, source: "remote" });
      }
      // Re-encoding usually takes longer than the download.
      const share = shrink ? 0.3 : 1;
      const bytes = await readWithProgress(res, (f) => advance(f * share, "downloading")).catch((err) => {
        throw isAbort(err) ? err : new Shown(stopped);
      });
      if (!alive.current || signal.aborted) return;
      let blob = new Blob([bytes as BlobPart], { type: "video/mp4" });
      let was: number | undefined;
      let note: string | undefined;
      if (shrink) {
        advance(share, "shrinking");
        try {
          const { compressVideo } = await import("@/lib/video-compress");
          const out = await compressVideo(blob, { signal, onProgress: (f) => advance(share + f * (1 - share), "shrinking") });
          if (out.blob.size < blob.size) {
            was = blob.size;
            blob = out.blob;
          } else {
            note = "Already compact, so this is the original.";
          }
        } catch (err) {
          if (isAbort(err) || signal.aborted) return;
          note = "This browser couldn't make it smaller, so this is the original.";
        }
        if (!alive.current || signal.aborted) return;
      }
      releaseBlob();
      blobUrl.current = URL.createObjectURL(blob);
      finish({ href: blobUrl.current, name, size: blob.size, was, note, source: "blob" });
    } catch (err) {
      if (isAbort(err) || signal.aborted) return;
      fail(err instanceof Shown ? err.message : stopped);
    }
  }

  /** X, TikTok, Instagram audio: fetch the smallest MP4 and convert it in this tab, loading the converter meanwhile. */
  async function convertToMp3(href: string, name: string, from: string, signal: AbortSignal) {
    const stopped = `${from} stopped sending the video. Try again.`;
    let converterReady = false;
    const converter = import("@/lib/mp3").then(async (m) => {
      const c = await m.loadMp3Converter(signal);
      converterReady = true;
      return c;
    });
    converter.catch(() => null);
    let mp4: Uint8Array;
    try {
      const res = await fetchFile(href, from, signal);
      mp4 = await readWithProgress(res, (f) => advance(f * 0.4, "fetching")).catch((err) => {
        throw isAbort(err) ? err : new Shown(stopped);
      });
    } catch (err) {
      void converter.then((c) => c.dispose(), () => null);
      if (isAbort(err) || signal.aborted) return;
      return fail(err instanceof Shown ? err.message : stopped);
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
    flow.lock();
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

  // Back on the options (cancel or failure): they fill the slot they left.
  const releaseSlot = slot.release;
  useLayoutEffect(() => {
    if (phase === "preview") releaseSlot();
  }, [phase, releaseSlot]);

  const platformName = PLATFORM_LABEL[config.platform];
  const loading = phase === "loading";
  const available = info?.qualities.filter((q) => q.available) ?? [];
  // e.g. an X post that only exists in 1080p, for a free user.
  const allLocked = kind === "mp4" && available.length > 0 && available.every((q) => q.locked);
  const lockedOnly = allLocked ? available[available.length - 1].height : null;
  const chosen = info?.qualities.find((q) => q.height === height && q.available && !q.locked);
  const sized = kind === "mp4" && available.some((q) => q.size);
  // Only offered where re-encoding saves a lot; YouTube files come from the worker.
  const shrinkOffered = canShrink && kind === "mp4" && info?.platform !== "youtube" && !!chosen?.smaller;
  const toggleSmaller = () => {
    setSmaller(!smaller);
    writeSmaller(!smaller);
  };
  const returnTo = info ? `${pathname}?url=${encodeURIComponent(info.url)}` : pathname;
  const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  const radioKeys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next: MediaKind = kind === "mp4" ? "mp3" : "mp4";
    if (next === "mp3" && info?.hasAudio === false) return;
    slot.lock();
    setKind(next);
    setNote(null);
    (e.currentTarget.parentElement?.querySelector(`[data-kind="${next}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div className="space-y-4">
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
      <AnimatePresence mode="wait" initial={false}>
        {(phase === "input" || phase === "loading") && (
          <motion.form
            key="input"
            onSubmit={lookup}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={EXIT}
            transition={ENTER_T}
            onAnimationStart={(def) => def !== EXIT && flow.release()}
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
                  placeholder={PLATFORM_PLACEHOLDER[config.platform]}
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
                  exit={FADE_EXIT}
                  transition={NOTICE_T}
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
                <motion.p key="other" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mt-2 text-xs text-muted-foreground">
                  {detected.platform === "youtube" && !YOUTUBE_ENABLED
                    ? "YouTube downloads are paused for now."
                    : <>That&apos;s a {PLATFORM_LABEL[detected.platform]} link — it works here too.</>}
                </motion.p>
              )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
              {loading && (
                <motion.div
                  key="skeleton"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: DUR.fast, ease: EASE_OUT } }}
                  exit={FADE_EXIT}
                  className="mt-4 flex min-h-20 gap-3"
                  aria-hidden
                >
                  <Skeleton className="h-16 w-28 shrink-0 rounded-xl sm:h-20 sm:w-36" />
                  <div className="flex-1 space-y-2 py-1">
                    <Skeleton className="h-3 w-4/5 rounded" />
                    <Skeleton className="h-3 w-2/5 rounded" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.form>
        )}

        {info && (phase === "preview" || phase === "working") && (
          <motion.div
            key="preview"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={EXIT}
            transition={ENTER_T}
            className="flex flex-1 flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-xl shadow-primary/5"
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

            <div ref={slot.ref} className="flex flex-1 flex-col border-t border-border" style={{ minHeight: slot.minHeight }}>
            <AnimatePresence mode="wait" initial={false}>
            {phase === "preview" ? (
              <motion.div
                key="options"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: NOTICE_T }}
                exit={FADE_EXIT}
                className="flex flex-1 flex-col gap-4 p-4 sm:p-5"
              >
                <div className="inline-flex self-start rounded-xl bg-secondary p-1" role="radiogroup" aria-label="Format">
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
                        if (k !== kind) slot.lock();
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
                        <motion.span layoutId="kind-pill" className="absolute inset-0 bg-background shadow" style={{ borderRadius: 12 }} transition={SPRING_LAYOUT} />
                      )}
                      {/* Above every pill, so the pill never covers a label it passes. */}
                      <span className="relative z-[1] flex items-center gap-1.5">
                        {k === "mp4" ? <Film className="h-4 w-4" /> : <Music2 className="h-4 w-4" />}
                        {k.toUpperCase()} {k === "mp4" ? "video" : "audio"}
                      </span>
                    </button>
                  ))}
                </div>

                {/* MP3 has no quality: the block fades out of the space it
                    held (the card keeps its height, the buttons their place). */}
                <AnimatePresence initial={false}>
                  {kind === "mp4" && (
                    <motion.div
                      key="quality"
                      role="group"
                      aria-labelledby="quality-label"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0, transition: ENTER_T }}
                      exit={FADE_EXIT}
                    >
                      <p id="quality-label" className="mb-2 text-sm font-medium">
                        Quality
                      </p>
                      <div className="grid grid-cols-4 gap-2">
                        {info.qualities.map((q) => {
                          const chosen = height === q.height && !q.locked;
                          return (
                            <motion.button
                              key={q.height}
                              type="button"
                              whileTap={q.available ? { scale: 0.97 } : undefined}
                              onClick={() => pickQuality(q)}
                              disabled={!q.available}
                              aria-pressed={chosen}
                              aria-label={
                                q.available && (q.locked || q.size)
                                  ? `${q.height}p${q.size ? `, ${q.exact ? "" : "about "}${shortBytes(q.size)}` : ""}${q.locked ? " (Pro)" : ""}`
                                  : undefined
                              }
                              title={!q.available ? "Not available for this video" : q.locked ? "Pro" : undefined}
                              className={cn(
                                "relative flex flex-col items-center justify-center rounded-xl border px-2 text-sm font-semibold tabular-nums transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-35",
                                sized ? "h-14" : "h-11",
                                focusRing,
                                // Same sliding pill as the format toggle; the
                                // label turns white as the pill arrives.
                                // No fill of their own: the sliding pill shows through
                                // the chips it passes, under their labels.
                                chosen ? "border-primary" : "border-border hover:border-primary/50"
                              )}
                            >
                              {chosen && (
                                <motion.span
                                  layoutId="quality-pill"
                                  className="absolute -inset-px bg-primary shadow-md shadow-primary/25"
                                  style={{ borderRadius: 12 }}
                                  transition={SPRING_LAYOUT}
                                />
                              )}
                              <PillLabel chosen={chosen} slide={qualityPicked.current} off="hsl(var(--foreground))" className="z-[1]">
                                {q.height}p
                              </PillLabel>
                              {sized && q.available && q.size ? (
                                <PillLabel
                                  chosen={chosen}
                                  slide={qualityPicked.current}
                                  off="hsl(var(--foreground))"
                                  className="z-[1] mt-0.5 text-[11px] font-normal leading-none opacity-75"
                                >
                                  {q.exact ? "" : "~"}
                                  {shortBytes(q.size)}
                                </PillLabel>
                              ) : null}
                              {q.locked && q.available && (
                                <span className="absolute -right-1.5 -top-1.5 z-[1] flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-amber-400 to-fuchsia-500 text-white shadow">
                                  <Crown className="h-3 w-3" />
                                </span>
                              )}
                            </motion.button>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {shrinkOffered && chosen?.smaller && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={smaller}
                    aria-label={`Smaller file, about ${shortBytes(chosen.smaller)}`}
                    aria-describedby="smaller-note"
                    onClick={toggleSmaller}
                    title="Re-encoded on your device. Takes a little longer."
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-xl border border-border bg-background px-3.5 text-left text-sm transition-colors duration-fast hover:border-primary/50",
                      focusRing
                    )}
                  >
                    <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors duration-fast", smaller ? "bg-primary" : "bg-secondary")}>
                      <motion.span
                        className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background shadow"
                        initial={false}
                        animate={{ x: smaller ? 16 : 0 }}
                        transition={SPRING_LAYOUT}
                      />
                    </span>
                    <span className="flex-1 font-medium">Smaller file</span>
                    <span className="tabular-nums text-muted-foreground">~{shortBytes(chosen.smaller)}</span>
                    <span id="smaller-note" className="sr-only">
                      Re-encoded on your device. Takes a little longer.
                    </span>
                  </button>
                )}

                {note && <p className="text-sm text-muted-foreground">{note}</p>}

                <AnimatePresence initial={false}>
                {kind === "mp4" && (wantedLocked || allLocked) && (
                  <motion.button
                    key="pro"
                    type="button"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={FADE_EXIT}
                    transition={NOTICE_T}
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
                </AnimatePresence>

                <AnimatePresence>
                  {limit?.upgrade && (
                    <motion.button
                      type="button"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={FADE_EXIT}
                      transition={NOTICE_T}
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

                {/* Anchored to the card's foot, so the options above can come
                    and go without moving them; they glide if the card grows. */}
                <motion.div layout="position" transition={{ layout: SPRING_LAYOUT }} className="mt-auto flex flex-col gap-2 sm:flex-row">
                  <div className="flex-1">
                    {allLocked && info.hasAudio !== false ? (
                      <Button
                        ref={focusRef("download")}
                        size="lg"
                        className="w-full shadow-lg shadow-primary/25"
                        onClick={() => {
                          slot.lock();
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
                  </div>
                  <Button size="lg" variant="outline" onClick={reset}>
                    <RotateCcw /> Different link
                  </Button>
                </motion.div>
              </motion.div>
            ) : (
              <motion.div
                key="progress"
                ref={focusRef("progress")}
                tabIndex={-1}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0, transition: NOTICE_T }}
                exit={FADE_EXIT}
                className="flex flex-1 flex-col justify-center p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-5"
              >
                <ProgressBar value={progress.value} label="Download progress" />
                <p className="mt-2 text-center text-sm text-muted-foreground" aria-hidden>
                  {/* The number hangs off the label, so the label stays put as it grows. */}
                  <span className="relative">
                    {kind === "mp3" && progress.stage === "processing" ? STAGES.converting : (STAGES[progress.stage] ?? "Working…")}
                    <span className="absolute left-full top-0 ml-1">
                      <ProgressPercent value={progress.value} />
                    </span>
                  </span>
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
              </motion.div>
            )}
            </AnimatePresence>
            </div>
          </motion.div>
        )}

        {phase === "ready" && file && (
          <motion.div
            key="ready"
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, transition: EXIT_T }}
            transition={{ duration: DUR.slow, ease: EASE_OUT, opacity: ENTER_T }}
            className="relative flex flex-1 flex-col justify-center overflow-hidden rounded-3xl border border-border bg-card p-8 text-center shadow-xl shadow-primary/5"
          >
            <SuccessBadge icon={kind === "mp3" ? Music2 : Film} />
            <h2 ref={focusRef("ready")} tabIndex={-1} className="mx-auto mt-5 rounded-lg px-2 text-2xl font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Your download has started
            </h2>
            <p className="mx-auto mt-1 max-w-sm truncate text-sm text-muted-foreground">
              {file.name}
              {file.size ? ` · ${formatBytes(file.size)}` : ""}
              {file.size && file.was ? ` · ${Math.round((1 - file.size / file.was) * 100)}% smaller` : ""}
            </p>
            {file.note && <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{file.note}</p>}
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
      </div>

      <AnimatePresence>{error && <InlineError key="error" message={error} />}</AnimatePresence>

      <p className="text-center text-xs text-muted-foreground">Only download videos you have permission to use.</p>

      {upsell && <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo={returnTo} />}
    </div>
  );
}
