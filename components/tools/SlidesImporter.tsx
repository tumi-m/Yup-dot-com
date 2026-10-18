"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ClipboardPaste, Download, Link2, PenLine, Presentation, RotateCcw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DUR,
  EASE_OUT,
  ENTER_T,
  EXIT,
  EXIT_T,
  FADE_EXIT,
  InlineError,
  NOTICE_T,
  SuccessBadge,
} from "@/components/motion/primitives";
import { ProgressBar } from "@/components/motion/Progress";
import { settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { setHandoff } from "@/lib/local-store";
import { takeSent } from "@/lib/journey";
import { SLIDES_FAILURE_MESSAGE, SLIDES_MIME, slidesLinkProblem, type SlidesFormat } from "@/lib/google-slides";
import { linkIn } from "@/lib/media";
import { pasteBlockedMessage } from "@/lib/clipboard";
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
  /** Keeps the form's footprint while the result replaces it. */
  const flow = useHeightLock<HTMLDivElement>();
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
  /** Where focus goes when the form, its progress and the result swap. */
  const { next: focusNext, focusRef } = useFocusNext<"url" | "progress" | "ready">();
  /** Focus is in this flow (or was dropped to the page by a view that left it). */
  const focusHere = () =>
    document.activeElement === document.body || !!flow.ref.current?.contains(document.activeElement);

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

  const problem = url.trim() ? slidesLinkProblem(linkIn(url)) : null;
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
      if (focusHere()) focusNext.current = "url";
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
      if (focusHere()) focusNext.current = "url";
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

  async function run(which: Action, input = url, auto = false) {
    if (busy.current) return;
    setError(null);
    // Text around the link (copied from a message) is left behind.
    const link = linkIn(input);
    const bad = slidesLinkProblem(link);
    if (bad) {
      setError({ message: SLIDES_FAILURE_MESSAGE[bad] });
      return;
    }
    // The form's footprint is kept while the result replaces it.
    flow.lock();
    // The field is disabled and the buttons give way to the progress: it takes focus.
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "progress";
    busy.current = true;
    const mine = {};
    current.current = mine;
    setAction(which);
    try {
      const f = await fetchDeck(link);
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
        if (focusHere()) focusNext.current = "ready";
        settleSlot(flow.ref.current);
        setPhase("ready");
        return;
      }
      setFile({ ...f, saved: true });
      // The heading takes focus, which also tells a screen reader it's done.
      if (focusHere()) focusNext.current = "ready";
      // The page settles while the form leaves, so the card lands in view.
      settleSlot(flow.ref.current);
      setPhase("ready");
      saveAs(f.href, f.name);
      trackDownload(f.name);
    } catch {
      if (alive.current) {
        setError({ message: "Couldn't open this deck for editing. Try again." });
        if (focusHere()) focusNext.current = "url";
        setPhase("input");
      }
    } finally {
      // A cancelled run has already handed the form back.
      if (current.current === mine) busy.current = false;
    }
  }

  // ?url= fills in the box. Only when the homepage sent the user here does it
  // start by itself (?then=edit going straight to the editor): a link from
  // another site mustn't spend an import or save a file without a click.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const sent = takeSent(window.location.pathname + window.location.search);
    const link = params.get("url");
    if (!link) return;
    // Drop the params so Back or a reload doesn't import the deck again.
    window.history.replaceState(window.history.state, "", window.location.pathname);
    setUrl(link);
    if (sent) void run(format === "pptx" && params.get("then") === "edit" ? "edit" : "download", link, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cancel() {
    focusNext.current = "url";
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
      if (text) setUrl(linkIn(text));
    } catch {
      setError({ message: pasteBlockedMessage() });
    }
  }

  function reset() {
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "url";
    flow.lock();
    releaseBlob();
    setFile(null);
    setUrl("");
    setError(null);
    setPhase("input");
  }

  const fraction = progress.total ? Math.min(1, progress.received / progress.total) : 0;

  return (
    <div className="space-y-4">
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
      <AnimatePresence mode="wait" initial={false}>
        {phase !== "ready" && (
          <motion.form
            key="input"
            onSubmit={(e) => {
              e.preventDefault();
              void run("download");
            }}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={EXIT}
            transition={ENTER_T}
            onAnimationStart={(def) => def !== EXIT && flow.release()}
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
                ref={focusRef("url")}
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
                  exit={FADE_EXIT}
                  transition={NOTICE_T}
                  className="mt-2 text-xs text-muted-foreground"
                >
                  {problem === "published" ? SLIDES_FAILURE_MESSAGE.published : "Not a Google Slides link."}
                </motion.p>
              )}
            </AnimatePresence>

            {phase === "fetching" ? (
              <div
                ref={focusRef("progress")}
                tabIndex={-1}
                className="-mx-2 mt-2 rounded-xl px-2 pt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ProgressBar value={fraction} label="Import progress" />
                <div className="mt-2 flex items-center justify-center gap-2">
                  <p className="text-sm text-muted-foreground">
                    {/* Only the stage is read out; the byte count changes with every chunk. */}
                    <span role="status">
                      {progress.received ? "Downloading…" : "Exporting from Google…"}
                      {action === "edit" && <span className="sr-only"> Opening in the editor</span>}
                    </span>
                    {progress.received > 0 && (
                      <span aria-hidden className="ml-1 tabular-nums">
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
                <Button type="submit" size="lg" className="h-12 flex-1 shadow-lg shadow-primary/25" disabled={!url.trim()}>
                  <Download /> Download {ext}
                </Button>
                {format === "pptx" && (
                  <Button type="button" size="lg" variant="outline" className="h-12 sm:min-w-32" disabled={!url.trim()} onClick={() => void run("edit")}>
                    <PenLine /> Edit
                  </Button>
                )}
              </div>
            )}
          </motion.form>
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
            <SuccessBadge icon={Presentation} />
            <h2
              ref={focusRef("ready")}
              tabIndex={-1}
              className="mx-auto mt-5 rounded-lg px-2 text-2xl font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {file.saved ? "Downloaded" : "Ready"}
            </h2>
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
      </div>

      <AnimatePresence>
        {error && (
          <InlineError key="error" message={error.message}>
            {error.upgrade && tier !== "pro" && tier !== "team" && (
              <Link href="/pricing" className="tap font-semibold underline underline-offset-2">
                Upgrade
              </Link>
            )}
          </InlineError>
        )}
      </AnimatePresence>
    </div>
  );
}
