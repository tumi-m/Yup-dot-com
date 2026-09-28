"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  ClipboardPaste,
  Crown,
  Download,
  Film,
  Link2,
  Loader2,
  Music2,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EASE, SPRING, SparkleBurst } from "@/components/motion/primitives";
import { UpgradeDialog, type UpsellReason } from "@/components/upsell/Upsell";
import { parseMediaUrl, PLATFORM_LABEL, type MediaKind, type MediaPlatform } from "@/lib/media";
import type { Tier } from "@/lib/limits";
import { cn, formatBytes } from "@/lib/utils";

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
}

type Phase = "input" | "loading" | "preview" | "working" | "ready";

const STAGES: Record<string, string> = {
  queued: "Getting ready…",
  downloading: "Downloading…",
  processing: "Merging audio and video…",
  fetching: "Fetching the video…",
  converting: "Converting to MP3…",
  ready: "Ready",
};

/** Give up on a stuck worker job rather than spinning forever. */
const POLL_DEADLINE_MS = 20 * 60 * 1000;
const POLL_MAX_FAILURES = 6;

function saveAs(href: string, name?: string) {
  const a = document.createElement("a");
  a.href = href;
  a.rel = "noopener";
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Reads a same-origin response into memory, reporting progress when the size is known. */
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
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function duration(s?: number | null) {
  if (!s) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

export function MediaDownloader({ config, tier }: { config: MediaToolConfig; tier: Tier }) {
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [info, setInfo] = useState<Info | null>(null);
  const [kind, setKind] = useState<MediaKind>(config.kind);
  const [height, setHeight] = useState<number>(config.defaultHeight ?? 720);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ value: number; stage: string }>({ value: 0, stage: "queued" });
  const [file, setFile] = useState<{ href: string; name: string; size?: number | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [wantedLocked, setWantedLocked] = useState(false);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busy = useRef(false);
  const [starting, setStarting] = useState(false);
  const blobUrl = useRef<string | null>(null);
  const alive = useRef(true);

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
      stopPolling();
      releaseBlob();
    };
  }, []);

  const detected = url ? parseMediaUrl(url) : null;

  async function lookup(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!detected) {
      setError(`Paste a ${PLATFORM_LABEL[config.platform]} video link.`);
      return;
    }
    setPhase("loading");
    const res = await fetch("/api/media/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) {
      setError(data?.error ?? "Couldn't read that link.");
      setPhase("input");
      return;
    }
    setInfo(data);
    setNote(null);
    if (data.platform !== "x") setKind("mp4");
    else if (kind === "mp3" && data.hasAudio === false) {
      setKind("mp4");
      setNote("This is a GIF, so it has no sound. It downloads as MP4.");
    }
    // Start on the requested quality if possible, else the best unlocked one.
    const usable = (data.qualities as Info["qualities"]).filter((q) => q.available);
    const wanted = config.defaultHeight ?? 720;
    const preferred = usable.find((q) => q.height === wanted && !q.locked);
    // On the 1080p page, explain why a free user starts at 720p.
    setWantedLocked(usable.some((q) => q.height === wanted && q.locked));
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

  async function start() {
    if (busy.current) return;
    busy.current = true;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/media/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, kind, height: kind === "mp4" ? height : undefined }),
      }).catch(() => null);
      const data = await res?.json().catch(() => ({}));
      if (!res?.ok) {
        if (data?.upgrade) setUpsell(data.reason === "quality" ? "quality" : "downloads");
        else setError(data?.error ?? (res ? "Couldn't start the download." : "You're offline. Check your connection."));
        return;
      }
      if (data.mode === "direct") return finishDirect(data.href, data.filename);
      if (data.mode === "convert") return await convertToMp3(data.href, data.filename);
      await runWorkerJob(data.workerUrl, data.token);
    } finally {
      busy.current = false;
      if (alive.current) setStarting(false);
    }
  }

  /** X video: our own origin streams it as an attachment. */
  function finishDirect(href: string, name: string) {
    setFile({ href, name, size: null });
    setPhase("ready");
    saveAs(href);
  }

  /** X audio: fetch the smallest MP4 and convert it in this tab. */
  async function convertToMp3(href: string, name: string) {
    setPhase("working");
    setProgress({ value: 0, stage: "fetching" });
    try {
      const res = await fetch(href);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Couldn't fetch the video.");
      }
      const mp4 = await readWithProgress(res, (f) => setProgress({ value: f * 0.4, stage: "fetching" }));
      setProgress({ value: 0.4, stage: "converting" });
      const { mp4ToMp3 } = await import("@/lib/mp3");
      const mp3 = await mp4ToMp3(mp4, (f) => setProgress({ value: 0.4 + f * 0.6, stage: "converting" }));
      if (!alive.current) return;
      releaseBlob();
      blobUrl.current = URL.createObjectURL(new Blob([mp3 as BlobPart], { type: "audio/mpeg" }));
      setFile({ href: blobUrl.current, name, size: mp3.byteLength });
      setPhase("ready");
      saveAs(blobUrl.current, name);
    } catch (err) {
      if (!alive.current) return;
      const message = err instanceof Error && err.message && !/^(Error|RuntimeError|TypeError)\b/.test(err.message)
        ? err.message
        : "Converting to MP3 failed in this browser. Download the MP4 instead.";
      setError(message);
      setPhase("preview");
    }
  }

  /** YouTube: the media worker downloads and merges; we poll until the file is ready. */
  async function runWorkerJob(workerUrl: string, token: string) {
    setPhase("working");
    setProgress({ value: 0, stage: "queued" });
    const job = await fetch(`${workerUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    const created = await job?.json().catch(() => ({}));
    if (!job?.ok || !created?.id) {
      setError(created?.error ?? "The download server isn't responding. Try again in a minute.");
      setPhase("preview");
      return;
    }

    const deadline = Date.now() + POLL_DEADLINE_MS;
    let failures = 0;
    const fail = (message: string) => {
      stopPolling();
      setError(message);
      setPhase("preview");
    };
    const tick = async () => {
      poll.current = null;
      if (!alive.current) return;
      if (Date.now() > deadline) return fail("This download is taking too long. Try a lower quality.");
      const r = await fetch(`${workerUrl}/jobs/${created.id}`, { cache: "no-store" }).catch(() => null);
      const s = await r?.json().catch(() => null);
      if (!alive.current) return;
      if (!r || !s) {
        if (++failures >= POLL_MAX_FAILURES) return fail("Lost contact with the download server. Try again.");
      } else if (!r.ok || s.status === "error") {
        return fail(s.error ?? "Download failed.");
      } else {
        failures = 0;
        setProgress({ value: s.progress ?? 0, stage: s.stage ?? "downloading" });
        if (s.status === "ready") {
          const href = `${workerUrl}/jobs/${created.id}/file`;
          setFile({ href, name: s.filename, size: s.size });
          setPhase("ready");
          saveAs(href);
          return;
        }
      }
      poll.current = setTimeout(tick, 1000);
    };
    poll.current = setTimeout(tick, 800);
  }

  function reset() {
    stopPolling();
    releaseBlob();
    setNote(null);
    setUrl("");
    setInfo(null);
    setFile(null);
    setError(null);
    setPhase("input");
  }

  const platformName = PLATFORM_LABEL[config.platform];

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
          >
            <label htmlFor="media-url" className="mb-2 block text-sm font-medium">
              {platformName} link
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="media-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={config.platform === "youtube" ? "https://www.youtube.com/watch?v=…" : "https://x.com/user/status/…"}
                  inputMode="url"
                  autoComplete="off"
                  className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-24 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={paste}
                  className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <ClipboardPaste className="h-3.5 w-3.5" /> Paste
                </button>
              </div>
              <Button type="submit" size="lg" className="h-12 min-w-36 shadow-lg shadow-primary/25" disabled={phase === "loading" || !url.trim()}>
                {phase === "loading" ? <Loader2 className="animate-spin" /> : <Download />}
                {phase === "loading" ? "Reading link…" : "Get video"}
              </Button>
            </div>
            <AnimatePresence>
              {detected && detected.platform !== config.platform && (
                <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 text-xs text-muted-foreground">
                  That&apos;s a {PLATFORM_LABEL[detected.platform]} link — it works here too.
                </motion.p>
              )}
            </AnimatePresence>
            {phase === "loading" && (
              <div className="mt-4 flex gap-3" aria-hidden>
                <div className="h-20 w-36 animate-pulse rounded-xl bg-secondary" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-3 w-4/5 animate-pulse rounded bg-secondary" />
                  <div className="h-3 w-2/5 animate-pulse rounded bg-secondary" />
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
            <div className="flex gap-4 p-5">
              <div className="relative h-24 w-40 shrink-0 overflow-hidden rounded-xl bg-secondary">
                {info.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={info.thumbnail} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                )}
                {duration(info.duration) && (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
                    {duration(info.duration)}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 font-semibold leading-snug">{info.title}</p>
                {info.uploader && <p className="mt-1 truncate text-sm text-muted-foreground">{info.uploader}</p>}
                <p className="mt-1 text-xs text-muted-foreground">{PLATFORM_LABEL[info.platform]}</p>
              </div>
            </div>

            {phase === "preview" ? (
              <div className="space-y-4 border-t border-border p-5">
                {info.platform === "x" && (
                  <div className="inline-flex rounded-xl bg-secondary p-1" role="radiogroup" aria-label="Format">
                    {(["mp4", "mp3"] as const).map((k) => (
                      <button
                        key={k}
                        role="radio"
                        aria-checked={kind === k}
                        disabled={k === "mp3" && info.hasAudio === false}
                        onClick={() => {
                          setKind(k);
                          setNote(null);
                        }}
                        className={cn(
                          "relative flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-40",
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
                )}

                {kind === "mp4" && (
                  <div>
                    <p className="mb-2 text-sm font-medium">Quality</p>
                    <div className="grid grid-cols-4 gap-2">
                      {info.qualities.map((q) => (
                        <motion.button
                          key={q.height}
                          whileTap={q.available ? { scale: 0.95 } : undefined}
                          onClick={() => pickQuality(q)}
                          disabled={!q.available}
                          aria-pressed={height === q.height}
                          title={!q.available ? "Not available for this video" : q.locked ? "Pro" : undefined}
                          className={cn(
                            "relative rounded-xl border px-2 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                            height === q.height && !q.locked
                              ? "border-primary bg-primary text-primary-foreground shadow-md shadow-primary/25"
                              : "border-border bg-background hover:border-primary/50"
                          )}
                        >
                          {q.height}p
                          {q.height >= 720 && <span className="ml-1 text-[10px] font-medium opacity-70">HD</span>}
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

                {kind === "mp4" && wantedLocked && (
                  <motion.button
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    onClick={() => setUpsell("quality")}
                    className="flex w-full items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3.5 py-2.5 text-left text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                  >
                    <Crown className="h-4 w-4 shrink-0 text-amber-500" />
                    <span className="flex-1">Full HD 1080p is part of Pro — we&apos;ve picked {height}p for you.</span>
                    <span className="font-semibold underline">Unlock 1080p</span>
                  </motion.button>
                )}

                <div className="flex flex-col gap-2 sm:flex-row">
                  <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="flex-1">
                    <Button size="lg" className="w-full shadow-lg shadow-primary/25" onClick={start} disabled={starting}>
                      {starting ? <Loader2 className="animate-spin" /> : <Download />} Download {kind === "mp3" ? "MP3" : `MP4 · ${height}p`}
                    </Button>
                  </motion.div>
                  <Button size="lg" variant="outline" onClick={reset}>
                    <RotateCcw /> Different link
                  </Button>
                </div>
              </div>
            ) : (
              <div className="border-t border-border p-5" aria-live="polite">
                <div className="relative h-3 overflow-hidden rounded-full bg-secondary">
                  {progress.value > 0.02 ? (
                    <motion.div
                      className="h-full rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400"
                      animate={{ width: `${Math.max(4, progress.value * 100)}%` }}
                      transition={{ ease: "easeOut", duration: 0.5 }}
                    />
                  ) : (
                    <motion.div
                      className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent"
                      animate={{ x: ["-100%", "300%"] }}
                      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                    />
                  )}
                </div>
                <p className="mt-2 text-center text-sm text-muted-foreground">
                  {STAGES[progress.stage] ?? "Working…"}
                  {progress.value > 0.02 && <span className="ml-1 tabular-nums">{Math.round(progress.value * 100)}%</span>}
                </p>
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
            <h2 className="mt-5 text-2xl font-bold">Your download has started</h2>
            <p className="mx-auto mt-1 max-w-sm truncate text-sm text-muted-foreground">
              {file.name}
              {file.size ? ` · ${formatBytes(file.size)}` : ""}
            </p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" variant="outline">
                <a href={file.href} rel="noopener" download={file.href.startsWith("blob:") ? file.name : undefined}>
                  <Download /> Download again
                </a>
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

      <p className="text-center text-xs text-muted-foreground">
        Only download videos you have permission to use.
      </p>

      {upsell && (
        <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(null)} reason={upsell} tier={tier} returnTo="/tools" />
      )}
    </div>
  );
}
