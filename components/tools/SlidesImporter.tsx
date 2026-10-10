"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ClipboardPaste, Download, Link2, Loader2, PenLine, Presentation, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EASE, SPRING, SparkleBurst } from "@/components/motion/primitives";
import { setHandoff } from "@/lib/local-store";
import { SLIDES_FAILURE_MESSAGE, SLIDES_MIME, slidesLinkProblem, type SlidesFormat } from "@/lib/google-slides";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { formatBytes } from "@/lib/utils";
import { trackDownload, trackToolUsed } from "@/lib/analytics";

type Phase = "input" | "fetching" | "ready";
type Action = "download" | "edit";

interface Fetched {
  href: string;
  name: string;
  size: number;
  blob: Blob;
  format: SlidesFormat;
  /** Saved to the device (not when it was fetched for the editor). */
  saved?: boolean;
}

function saveAs(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** "attachment; filename*=UTF-8''…" from our own route. */
function nameFrom(header: string | null, fallback: string): string {
  const star = header?.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* use fallback */
    }
  }
  return header?.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

export function SlidesImporter({ tier, format }: { tier: Tier; format: "pdf" | "pptx" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [action, setAction] = useState<Action>("download");
  const [error, setError] = useState<{ message: string; upgrade?: boolean } | null>(null);
  const [progress, setProgress] = useState<{ received: number; total: number }>({ received: 0, total: 0 });
  const [file, setFile] = useState<Fetched | null>(null);
  const busy = useRef(false);
  const alive = useRef(true);
  const blobUrl = useRef<string | null>(null);
  const autoRan = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const current = useRef<object | null>(null);

  const releaseBlob = () => {
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = null;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Only when the unmount is real: StrictMode remounts at once, and the
      // import started from ?url= must survive that.
      setTimeout(() => {
        if (alive.current) return;
        abort.current?.abort();
        releaseBlob();
      }, 0);
    };
  }, []);

  const problem = url.trim() ? slidesLinkProblem(url) : null;
  const ext = format.toUpperCase();

  async function fetchDeck(link: string): Promise<Fetched | null> {
    setProgress({ received: 0, total: 0 });
    setPhase("fetching");
    const controller = new AbortController();
    abort.current = controller;
    const res = await fetch(`/api/slides/export?url=${encodeURIComponent(link)}&format=${format}`, {
      signal: controller.signal,
    }).catch(() => null);
    if (controller.signal.aborted) return null;
    if (!res?.ok) {
      const data = await res?.json().catch(() => null);
      setError({
        message: data?.error ?? (res ? SLIDES_FAILURE_MESSAGE.unreachable : "You're offline. Check your connection."),
        upgrade: !!data?.upgrade,
      });
      setPhase("input");
      return null;
    }
    const total = Number(res.headers.get("content-length")) || 0;
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (alive.current) setProgress({ received, total });
      }
    } catch {
      if (controller.signal.aborted) return null;
      setError({ message: "The download was interrupted. Try again." });
      setPhase("input");
      return null;
    }
    if (controller.signal.aborted) return null;
    const blob = new Blob(chunks as BlobPart[], { type: SLIDES_MIME[format] });
    releaseBlob();
    blobUrl.current = URL.createObjectURL(blob);
    const name = nameFrom(res.headers.get("content-disposition"), `slides.${format}`);
    return { href: blobUrl.current, name, size: received, blob, format };
  }

  async function edit(f: Fetched, replace = false) {
    await setHandoff([{ name: f.name, type: SLIDES_MIME.pptx, bytes: new Uint8Array(await f.blob.arrayBuffer()) }]);
    // An automatic hop replaces this page, so Back doesn't bounce into the editor again.
    if (replace) router.replace("/tools/edit-pptx?handoff=1");
    else router.push("/tools/edit-pptx?handoff=1");
  }

  async function run(which: Action, link = url, auto = false) {
    if (busy.current) return;
    setError(null);
    const bad = slidesLinkProblem(link);
    if (bad) {
      setError({ message: SLIDES_FAILURE_MESSAGE[bad] });
      return;
    }
    busy.current = true;
    const mine = {};
    current.current = mine;
    setAction(which);
    try {
      const f = await fetchDeck(link.trim());
      if (!f || !alive.current || current.current !== mine) return;
      setFile(f);
      trackToolUsed();
      if (which === "edit") {
        const max = limitsFor(tier).maxFileBytes;
        if (f.size <= max) {
          await edit(f, auto);
          return;
        }
        // Too big to edit on this plan: keep the file, say why.
        setError({ message: `Editing takes files up to ${formatLimitBytes(max)} on your plan.`, upgrade: true });
        setPhase("ready");
        return;
      }
      setFile({ ...f, saved: true });
      setPhase("ready");
      saveAs(f.href, f.name);
      trackDownload(f.name);
    } catch {
      if (alive.current) {
        setError({ message: "Couldn't open this deck for editing. Try again." });
        setPhase("input");
      }
    } finally {
      // A cancelled run has already handed the form back.
      if (current.current === mine) busy.current = false;
    }
  }

  // ?url= prefills and starts; ?then=edit goes straight to the editor.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const link = params.get("url");
    if (!link) return;
    // Drop the params so Back or a reload doesn't import the deck again.
    window.history.replaceState(window.history.state, "", window.location.pathname);
    setUrl(link);
    void run(format === "pptx" && params.get("then") === "edit" ? "edit" : "download", link, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancel() {
    abort.current?.abort();
    abort.current = null;
    current.current = null;
    busy.current = false;
    setError(null);
    setPhase("input");
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setError({ message: "Clipboard blocked. Paste with Ctrl+V." });
    }
  }

  function reset() {
    releaseBlob();
    setFile(null);
    setUrl("");
    setError(null);
    setPhase("input");
  }

  const fraction = progress.total ? Math.min(1, progress.received / progress.total) : 0;

  return (
    <div className="space-y-4">
      <AnimatePresence mode="wait" initial={false}>
        {phase !== "ready" && (
          <motion.form
            key="input"
            onSubmit={(e) => {
              e.preventDefault();
              void run("download");
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="rounded-3xl border border-border bg-card p-5 shadow-xl shadow-primary/5"
          >
            <label htmlFor="slides-url" className="mb-2 flex items-center gap-2 text-sm font-medium">
              <span aria-hidden className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-400 text-amber-950 shadow-sm">
                <Presentation className="h-3.5 w-3.5" />
              </span>
              Google Slides link
            </label>
            <div className="relative">
              <Link2 aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="slides-url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                placeholder="docs.google.com/…"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={phase === "fetching"}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? "slides-url-hint" : undefined}
                className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-24 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
              />
              <button
                type="button"
                onClick={paste}
                disabled={phase === "fetching"}
                className="absolute right-0.5 top-1/2 flex h-11 min-w-11 -translate-y-1/2 items-center gap-1 rounded-lg px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ClipboardPaste aria-hidden className="h-3.5 w-3.5" /> Paste
              </button>
            </div>
            <AnimatePresence>
              {problem && !error && (
                <motion.p
                  id="slides-url-hint"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-2 text-xs text-muted-foreground"
                >
                  {problem === "published" ? SLIDES_FAILURE_MESSAGE.published : "Not a Google Slides link."}
                </motion.p>
              )}
            </AnimatePresence>

            {phase === "fetching" ? (
              <div className="mt-4">
                <div className="relative h-3 overflow-hidden rounded-full bg-secondary">
                  {fraction > 0.02 ? (
                    <motion.div
                      key="bar"
                      className="h-full rounded-full bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400"
                      animate={{ width: `${Math.max(4, fraction * 100)}%` }}
                      transition={{ ease: "easeOut", duration: 0.4 }}
                    />
                  ) : (
                    <motion.div
                      key="shimmer"
                      className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent"
                      animate={{ x: ["-100%", "300%"] }}
                      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                    />
                  )}
                </div>
                <div className="mt-2 flex items-center justify-center gap-2">
                  <p className="text-sm text-muted-foreground" aria-live="polite" role="status">
                    {progress.received ? "Downloading…" : "Exporting from Google…"}
                    {progress.received > 0 && (
                      <span className="ml-1 tabular-nums">
                        {formatBytes(progress.received)}
                        {progress.total ? ` / ${formatBytes(progress.total)}` : ""}
                      </span>
                    )}
                  </p>
                  <Button type="button" variant="ghost" size="sm" className="tap" onClick={cancel} data-testid="cancel-import">
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} tabIndex={-1} className="flex-1">
                  <Button type="submit" size="lg" className="h-12 w-full shadow-lg shadow-primary/25" disabled={!url.trim()}>
                    <Download /> Download {ext}
                  </Button>
                </motion.div>
                {format === "pptx" && (
                  <Button type="button" size="lg" variant="outline" className="h-12 sm:min-w-32" disabled={!url.trim()} onClick={() => void run("edit")}>
                    <PenLine /> Edit
                  </Button>
                )}
              </div>
            )}
            {phase === "fetching" && action === "edit" && <span className="sr-only">Opening in the editor</span>}
          </motion.form>
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
                <Presentation className="h-8 w-8" />
              </motion.div>
            </div>
            <h2 className="mt-5 text-2xl font-bold">{file.saved ? "Downloaded" : "Ready"}</h2>
            <p className="mx-auto mt-1 max-w-sm truncate text-sm text-muted-foreground" data-testid="slides-file">
              {file.name} · {formatBytes(file.size)}
            </p>
            <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" variant="outline">
                <a href={file.href} download={file.name} rel="noopener" onClick={() => trackDownload(file.name)}>
                  <Download /> {file.saved ? "Download again" : "Download"}
                </a>
              </Button>
              {file.format === "pptx" && file.size <= limitsFor(tier).maxFileBytes && (
                <Button size="lg" variant="outline" onClick={() => edit(file).catch(() => setError({ message: "Couldn't open this deck for editing. Try again." }))}>
                  <PenLine /> Edit
                </Button>
              )}
              <Button size="lg" onClick={reset}>
                <RotateCcw /> Another deck
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {error && (
          <motion.div
            role="alert"
            data-testid="tool-error"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1">{error.message}</span>
            {error.upgrade && tier !== "pro" && tier !== "team" && (
              <Link href="/pricing" className="tap font-semibold underline underline-offset-2">
                Upgrade
              </Link>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
