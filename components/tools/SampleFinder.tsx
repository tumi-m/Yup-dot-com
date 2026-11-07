"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ClipboardPaste, Crown, Disc3, Link2, Loader2, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DUR, EASE_OUT, ENTER_T, EXIT, FADE_EXIT, InlineError, NOTICE_T } from "@/components/motion/primitives";
import { settleSlot, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog } from "@/components/upsell/Upsell";
import { linkIn, parseMediaUrl, parsePlaylistUrl } from "@/lib/media";
import { takeSent } from "@/lib/journey";
import { pasteBlockedMessage } from "@/lib/clipboard";
import { trackSamples, trackToolUsed } from "@/lib/analytics";
import type { Tier } from "@/lib/limits";
import { parseTyped } from "@/lib/samples/parse";
import { artistKey } from "@/lib/samples/normalize";
import { INPUT_HELP, PLAYLIST_MESSAGE, SAMPLE_FINDER_PATH, linkProblem, shareHref, songQuery, splitSongQuery, tiktokPhotoLink } from "@/lib/samples/links";
import { firstTab, tabCounts, TABS } from "@/lib/samples/tabs";
import type { Candidate, Identified, LookupResult, Relation, SongRef, Tab, Variant, VideoInfo } from "@/lib/samples/types";
import { cn } from "@/lib/utils";
import { SongCard } from "./samples/SongCard";
import { CandidatePicker } from "./samples/CandidatePicker";
import { RelationTabs } from "./samples/RelationTabs";

type Phase = "input" | "identifying" | "choose" | "song";

interface Shown {
  song: SongRef;
  video: VideoInfo | null;
  variant: Variant | null;
  candidate: Candidate | null;
  /** The search it came from, for free re-picks; null for a song opened directly. */
  ident: Identified | null;
}

type Results =
  | { state: "idle" }
  | { state: "loading"; catalog: Relation[] }
  | { state: "done" | "busy" | "off" | "limit"; data: LookupResult }
  | { state: "error"; message: string; catalog: Relation[] };

type ApiError = { error?: string; typeIt?: boolean; reason?: string; upgrade?: boolean };

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** A button inside an error pill: full height to tap, without making the pill taller. */
const pillAction = "-my-3 inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 font-semibold underline";
const OFFLINE = "You're offline. Check your connection.";
const SHARED_HINT = "Press Find samples to look this song up.";
/** How long the box waits after the last key before saying a link can't be read. */
const SETTLE_MS = 600;

/** What the box holds: a link we can read, a playlist, a link we can't, or words. */
function readBox(text: string): { tag: string | null; problem: string | null } {
  const link = linkIn(text);
  if (!text.trim()) return { tag: null, problem: null };
  const media = parseMediaUrl(link);
  if (media?.platform === "youtube") return { tag: "YouTube", problem: null };
  if (media?.platform === "tiktok" || tiktokPhotoLink(link)) return { tag: "TikTok", problem: null };
  if (/^(https?:\/\/)?(www\.|m\.)?tiktok\.com\/music\//i.test(link)) return { tag: "TikTok sound", problem: null };
  if (parsePlaylistUrl(link)) return { tag: null, problem: PLAYLIST_MESSAGE };
  const problem = linkProblem(link);
  if (problem) return { tag: null, problem };
  if (media || /^https?:\/\//i.test(link)) return { tag: null, problem: INPUT_HELP };
  return { tag: null, problem: null };
}

/**
 * This page's own box sent the visitor here as a plain form submit: typed
 * and sent before the page was ready, so the search is theirs to run.
 */
function submittedHere(): boolean {
  try {
    const from = new URL(document.referrer);
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return from.origin === window.location.origin && from.pathname === SAMPLE_FINDER_PATH && nav?.type === "navigate" && nav.name === window.location.href;
  } catch {
    return false;
  }
}

const tabParam = (value: string | null): Tab | null => (value && TABS.includes(value as Tab) ? (value as Tab) : null);

/** Type it, filled in from what was read, leaving out what was only a guess. */
function typedDefaults(ident: Identified | null): { artist: string; title: string } {
  if (!ident) return { artist: "", title: "" };
  const { parsed } = ident;
  // A channel name is only a guess at the artist, and so is the artist in a
  // reaction video's title, unless a song found has it.
  const guessed =
    parsed.signals.includes("channel-guess") ||
    (parsed.signals.includes("reaction") && !ident.candidates.some((c) => artistKey(c.artist) === artistKey(parsed.artist)));
  return { artist: guessed ? "" : parsed.artist, title: parsed.title };
}

/** The note above the tabs when MusicBrainz's side is missing; null when there's nothing to say. */
function resultNote(state: Results["state"], rows: number, known: boolean): string | null {
  if (state === "busy") {
    return rows ? "MusicBrainz is busy, so these are our hand-checked results. Try again in a minute." : "MusicBrainz is busy and our list doesn't have this song. Try again in a minute.";
  }
  if (state === "off") return rows ? "Showing our hand-checked results only." : "Our hand-checked list doesn't have this song.";
  if (state === "limit") return rows ? "Daily lookups used. Hand-checked results are below." : "Daily lookups used, and our hand-checked list doesn't have this song.";
  if (state === "done" && !known) {
    return rows ? "MusicBrainz doesn't have this song yet. These are our hand-checked results." : "MusicBrainz doesn't have this song yet, and it isn't on our list.";
  }
  return null;
}

const asResult = (song: SongRef, relations: Relation[], mb: LookupResult["mb"]): LookupResult => ({
  song,
  relations,
  counts: tabCounts(relations),
  mb,
  listen: null,
  remaining: null,
});

export function SampleFinder({ tier }: { tier: Tier }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const [text, setText] = useState(() => params.get("q")?.trim() || params.get("url")?.trim() || "");
  /** The box's text as of the last pause in typing (or leaving the box): only then is a link judged. */
  const [settled, setSettled] = useState(text);
  // A shared result opens from the cache: the box shows it's reading meanwhile.
  const [phase, setPhase] = useState<Phase>(() => (params.get("q")?.trim() && MBID.test(params.get("rec")?.trim() ?? "") ? "identifying" : "input"));
  const [error, setError] = useState<{ message: string; typeIt: boolean } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [ident, setIdent] = useState<Identified | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [results, setResults] = useState<Results>({ state: "idle" });
  const [tab, setTab] = useState<Tab>(() => tabParam(params.get("tab")) ?? "samples");
  const [picking, setPicking] = useState(false);
  const [shared, setShared] = useState(false);
  const [upsell, setUpsell] = useState(false);
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  const seq = useRef(0);
  const usedOnce = useRef(false);
  /** The tab came from the address, so the first results keep it. */
  const tabFromLink = useRef(!!tabParam(params.get("tab")));
  const flow = useHeightLock<HTMLDivElement>();
  const { next: focusNext, focusRef } = useFocusNext<"input" | "song" | "picker" | "notThis">();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Keeps the address bar on the song (never the video link), so a refresh
   * or a share shows the same. `push` gives it its own entry, for Back.
   */
  function syncAddress(href: string | null, push = false) {
    const next = href ?? pathname;
    if (window.location.pathname + window.location.search === next) return;
    if (push) window.history.pushState(null, "", next);
    else window.history.replaceState(null, "", next);
  }

  // ?q=…&rec=… (a shared result) opens from the cache; ?url= or ?q= fills
  // the box, and runs only when this site sent the visitor.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const q = params.get("q")?.trim() ?? "";
    const rec = params.get("rec")?.trim() ?? "";
    if (q && MBID.test(rec)) {
      void openShared(q, rec, { tab: tabParam(params.get("tab")) });
      return;
    }
    // Typed before the page was ready: keep what's in the box.
    const early = (document.getElementById("sample-input") as HTMLInputElement | null)?.value ?? "";
    if (early && early !== text) {
      setText(early);
      setSettled(early);
    }
    const value = params.get("url")?.trim() || q;
    if (value && (takeSent(window.location.href) || submittedHere())) void identify(value, "auto", { auto: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Back and Forward between songs opened here ("Find its samples" adds an entry).
  const onPop = useRef(() => {});
  useEffect(() => {
    onPop.current = () => {
      const p = new URLSearchParams(window.location.search);
      const q = p.get("q")?.trim() ?? "";
      const rec = p.get("rec")?.trim() ?? "";
      const t = tabParam(p.get("tab"));
      if (q && MBID.test(rec)) {
        tabFromLink.current = !!t;
        if (t) setTab(t);
        void openShared(q, rec, { tab: t, inPlace: phase === "song", focus: true });
        return;
      }
      // An entry with no song: the box, with whatever it held.
      seq.current++;
      setWorking(false);
      setIdent(null);
      setShown(null);
      setResults({ state: "idle" });
      setError(null);
      setPicking(false);
      setText(q);
      setSettled(q);
      focusNext.current = "input";
      setPhase("input");
    };
  });
  useEffect(() => {
    const handler = () => onPop.current();
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  // A link is judged once typing pauses, not at every key.
  useEffect(() => {
    if (settled === text) return;
    const timer = window.setTimeout(() => setSettled(text), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [text, settled]);

  const identifying = phase === "identifying";
  // A wait that runs long (MusicBrainz slow) says what it's waiting for.
  useEffect(() => {
    if (!identifying) return;
    const timer = window.setTimeout(() => setSlow(true), 3000);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [identifying]);

  async function post<T>(path: string, body: unknown): Promise<{ res: Response | null; data: (T & ApiError) | null }> {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    return { res, data };
  }

  /**
   * A shared result (?q=…&rec=…), from the cache only. It's shown once the
   * cache has that recording, under MusicBrainz's own artist and title, never
   * the link's words; one not looked up here yet goes in the box instead.
   */
  async function openShared(q: string, rec: string, opts: { tab: Tab | null; inPlace?: boolean; focus?: boolean }) {
    const n = ++seq.current;
    setError(null);
    setHint(null);
    setPicking(false);
    setWorking(true);
    if (!opts.inPlace) setPhase("identifying");
    const { artist, title } = splitSongQuery(q);
    const { res, data } = await post<LookupResult>("/api/samples/lookup", { rec, artist, title, cacheOnly: true });
    if (!alive.current || n !== seq.current) return;
    setWorking(false);
    if (res?.ok && data?.relations && data.cached) {
      setShown({ song: data.song, video: null, variant: null, candidate: null, ident: null });
      setShared(false);
      setPhase("song");
      if (opts.focus) focusNext.current = "song";
      syncAddress(shareHref(data.song, opts.tab));
      landed({ state: "done", data });
      return;
    }
    setShown(null);
    setResults({ state: "idle" });
    setText(q);
    setSettled(q);
    if (res?.ok && data?.relations) setHint(SHARED_HINT);
    else setError({ message: data?.error ?? (res ? "Couldn't open that link. Try again." : OFFLINE), typeIt: false });
    if (opts.focus) focusNext.current = "input";
    setPhase("input");
  }

  /**
   * Reads the box (or typed words) and picks the song, or asks which one.
   * `auto`: the page started it, so focus stays put. `push`: the song gets
   * its own history entry. `typeIt`: typed in the form, after asking.
   */
  async function identify(input: string, how: "auto" | "typed", opts: { auto?: boolean; push?: boolean; typeIt?: boolean } = {}) {
    const value = input.trim();
    if (!value || working) return;
    const auto = !!opts.auto;
    const n = ++seq.current;
    setError(null);
    setHint(null);
    setWorking(true);
    setPicking(false);
    if (phase !== "song") setPhase("identifying");
    if (!auto) flow.reserve(window.innerWidth < 640 ? 480 : 420);
    const { res, data } = await post<Identified>("/api/samples/identify", { input: value });
    if (!alive.current || n !== seq.current) return;
    setWorking(false);
    if (!res?.ok || !data) {
      flow.release();
      setError({ message: data?.error ?? (res ? "Couldn't read that. Try again." : OFFLINE), typeIt: !!data?.typeIt });
      if (!auto) focusNext.current = "input";
      if (phase !== "song") setPhase("input");
      return;
    }
    setIdent(data);
    trackSamples({ name: "samples_search", input: data.source });
    const from = { video: data.video, variant: data.parsed.variant, ident: data };
    if (data.band !== "low" && data.pick) {
      trackSamples({ name: "samples_identified", confidence: data.band, pick: how === "typed" ? "typed" : "auto" });
      open(data.pick, { ...from, candidate: data.candidates[0] ?? null }, how, { auto, push: opts.push });
    } else if (opts.typeIt && data.mb === "ok" && !data.candidates.length && data.parsed.title) {
      // Typed after asking, and MusicBrainz still has nothing: show what was
      // typed, saying so, rather than ask the same question again.
      trackSamples({ name: "samples_identified", confidence: data.band, pick: "typed" });
      open({ artist: data.parsed.artist, title: data.parsed.title, year: null, mbid: null }, { ...from, candidate: null }, "typed", { push: opts.push });
    } else {
      if (!auto) focusNext.current = "picker";
      setShown(null);
      setResults({ state: "idle" });
      setPhase("choose");
    }
  }

  /** Shows a song and looks up its connections. */
  function open(song: SongRef, from: Omit<Shown, "song">, how: "auto" | "alternative" | "typed", opts: { auto?: boolean; push?: boolean } = {}) {
    const next: Shown = { song, ...from };
    setShown(next);
    setPicking(false);
    setShared(false);
    setHint(null);
    setPhase("song");
    if (!opts.auto) focusNext.current = "song";
    if (!tabFromLink.current) setTab("samples");
    syncAddress(shareHref(song, tabFromLink.current ? tab : null), opts.push);
    void lookup(next);
    if (how === "alternative") trackSamples({ name: "samples_identified", confidence: from.ident?.band ?? "low", pick: "alternative" });
  }

  async function lookup(s: Shown) {
    const n = ++seq.current;
    const catalog = s.ident && s.ident.pick?.mbid === s.song.mbid ? s.ident.catalog : [];
    // MusicBrainz was busy or off when the song was read: only the hand-checked list.
    if (!s.song.mbid && s.ident && s.ident.mb !== "ok") {
      landed({ state: s.ident.mb === "off" ? "off" : "busy", data: asResult(s.song, s.ident.catalog, s.ident.mb) });
      return;
    }
    setResults({ state: "loading", catalog });
    const { res, data } = await post<LookupResult>("/api/samples/lookup", {
      rec: s.song.mbid ?? null,
      alt: s.candidate?.mbid === s.song.mbid ? s.candidate?.alt : undefined,
      artist: s.song.artist,
      title: s.song.title,
      ticket: s.ident?.ticket ?? null,
    });
    if (!alive.current || n !== seq.current) return;
    if (res?.status === 429 && data?.reason === "samples" && data.relations) {
      trackSamples({ name: "samples_limit", tier });
      landed({ state: "limit", data });
      return;
    }
    if (!res?.ok || !data?.relations) {
      setResults({ state: "error", message: data?.error ?? (res ? "Couldn't look that up. Try again." : OFFLINE), catalog });
      return;
    }
    // The song as MusicBrainz knows it: its artist and title, year and id.
    setShown((cur) => (cur && cur.song.mbid === s.song.mbid ? { ...cur, song: { ...cur.song, ...data.song } } : cur));
    landed({ state: data.mb === "busy" ? "busy" : data.mb === "off" ? "off" : "done", data });
  }

  function landed(r: Extract<Results, { data: LookupResult }>) {
    setResults(r);
    const { counts } = r.data;
    if (!tabFromLink.current) setTab(firstTab(counts));
    tabFromLink.current = false;
    trackSamples({ name: "samples_results", samples: counts.samples, sampled_by: counts.sampled, covers: counts.covers, remixes: counts.remixes, mb: r.data.mb });
    if (!usedOnce.current) {
      usedOnce.current = true;
      trackToolUsed("sample-finder");
    }
  }

  function changeTab(t: Tab) {
    setTab(t);
    trackSamples({ name: "samples_tab", tab: t });
    if (shown) syncAddress(shareHref(shown.song, t));
  }

  function explore(r: Relation) {
    trackSamples({ name: "samples_explore" });
    settleSlot(flow.ref.current);
    // Its own history entry, so Back returns to this song.
    if (r.mbid) {
      open({ artist: r.artist, title: r.title, year: r.year, mbid: r.mbid }, { video: null, variant: null, candidate: null, ident: null }, "typed", { push: true });
    } else {
      setText(songQuery(r));
      void identify(songQuery(r), "typed", { push: true });
    }
  }

  async function share() {
    if (!shown) return;
    const url = `${window.location.origin}${shareHref(shown.song, tab)}`;
    const title = `${shown.song.title}${shown.song.artist ? ` by ${shown.song.artist}` : ""}: samples and covers`;
    if (typeof navigator.share === "function" && window.matchMedia("(pointer: coarse)").matches) {
      try {
        await navigator.share({ title, url });
        trackSamples({ name: "samples_share", method: "native" });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      trackSamples({ name: "samples_share", method: "copy" });
    } catch {
      setError({ message: "Couldn't copy. The link is in the address bar.", typeIt: false });
    }
  }

  async function paste() {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) {
        setText(linkIn(clip));
        setSettled(linkIn(clip));
      }
    } catch {
      setError({ message: pasteBlockedMessage(), typeIt: false });
    }
  }

  function reset() {
    flow.lock();
    seq.current++;
    setWorking(false);
    setText("");
    setSettled("");
    setIdent(null);
    setShown(null);
    setResults({ state: "idle" });
    setError(null);
    setHint(null);
    setPicking(false);
    syncAddress(null);
    focusNext.current = "input";
    setPhase("input");
  }

  const box = readBox(text);
  // Said once typing pauses; while a problem is already showing, it follows the text at once.
  const problem = box.problem && (settled === text || readBox(settled).problem) ? box.problem : null;
  const data = "data" in results ? results.data : null;
  const relations = data?.relations ?? ("catalog" in results ? results.catalog : []);
  const counts = data?.counts ?? tabCounts(relations);
  const remaining = data?.remaining ?? null;
  const known = !!shown?.song.mbid;
  const total = counts.samples + counts.sampled + counts.covers + counts.remixes;
  // What an empty tab says when MusicBrainz wasn't asked about this song, or couldn't answer.
  const unchecked =
    results.state === "loading"
      ? "Checking MusicBrainz…"
      : results.state === "busy" || results.state === "error"
        ? "Couldn't check MusicBrainz."
        : results.state === "off" || results.state === "limit" || !known
          ? "Not on our hand-checked list."
          : null;
  const note = resultNote(results.state, relations.length, known);
  const summary = !data ? "" : results.state === "done" && known ? `${total} ${total === 1 ? "connection" : "connections"} found.` : (note ?? "");

  return (
    <div className="space-y-4">
      <div ref={flow.ref} className="flex flex-col" style={{ minHeight: flow.minHeight }}>
        {/* One view leaves before the next arrives: never both on screen at once. */}
        <AnimatePresence mode="wait" initial={false}>
          {(phase === "input" || phase === "identifying") && (
            <motion.form
              key="input"
              // Before the page is ready a press still searches: a plain submit
              // brings the words back here (?q=), and the search runs then.
              action={SAMPLE_FINDER_PATH}
              onSubmit={(e) => {
                e.preventDefault();
                if (!text.trim() || identifying) return;
                if (box.problem) {
                  setSettled(text);
                  return;
                }
                void identify(text, "auto");
              }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={EXIT}
              transition={ENTER_T}
              onAnimationStart={(def) => def !== EXIT && flow.release()}
              className="rounded-3xl border border-border bg-card p-5 shadow-xl shadow-primary/5"
              aria-busy={identifying}
            >
              <label htmlFor="sample-input" className="mb-2 block text-sm font-medium">
                Link or song
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id="sample-input"
                    name="q"
                    data-testid="sample-input"
                    ref={focusRef("input")}
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      setError(null);
                      setHint(null);
                    }}
                    onBlur={() => setSettled(text)}
                    readOnly={identifying}
                    placeholder="Paste a YouTube or TikTok link, or type Artist – Title"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={500}
                    aria-describedby="sample-input-status sample-input-tag"
                    aria-invalid={!!problem || undefined}
                    className="h-12 w-full rounded-xl border border-input bg-background pl-10 pr-24 text-sm outline-none focus:ring-2 focus:ring-ring read-only:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={paste}
                    disabled={identifying}
                    className={cn(
                      "absolute right-0.5 top-1/2 flex h-11 -translate-y-1/2 items-center gap-1 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50",
                      focusRing
                    )}
                  >
                    <ClipboardPaste className="h-3.5 w-3.5" /> Paste
                  </button>
                </div>
                <Button type="submit" size="lg" className="h-12 min-w-40 shadow-lg shadow-primary/25" disabled={identifying}>
                  {identifying ? <Loader2 className="motion-safe:animate-spin" /> : <Search />}
                  {identifying ? "Reading…" : "Find samples"}
                </Button>
              </div>
              <div id="sample-input-status" aria-live="polite">
                <AnimatePresence initial={false} mode="wait">
                  {slow ? (
                    <motion.p key="slow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mt-2 text-xs text-muted-foreground" data-testid="input-slow">
                      Still checking MusicBrainz…
                    </motion.p>
                  ) : problem ? (
                    <motion.p key="problem" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mt-2 text-xs font-medium text-amber-700" data-testid="input-problem">
                      {problem}
                    </motion.p>
                  ) : hint ? (
                    <motion.p key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mt-2 text-xs text-muted-foreground" data-testid="input-hint">
                      {hint}
                    </motion.p>
                  ) : null}
                </AnimatePresence>
              </div>
              {/* The kind of link, shown as it's typed; not announced at every key. */}
              <div id="sample-input-tag">
                <AnimatePresence initial={false}>
                  {box.tag && !slow && !hint && (
                    <motion.p key="tag" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mt-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground" data-testid="input-tag">
                      {box.tag} link
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
              <AnimatePresence initial={false}>
                {identifying && (
                  <motion.div
                    key="skeleton"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: DUR.fast, ease: EASE_OUT } }}
                    exit={FADE_EXIT}
                    className="mt-4 flex min-h-20 gap-3"
                    aria-hidden
                  >
                    <Skeleton className="h-20 w-20 shrink-0 rounded-xl" />
                    <div className="flex-1 space-y-2 py-1">
                      <Skeleton className="h-3 w-3/5 rounded" />
                      <Skeleton className="h-3 w-2/5 rounded" />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.form>
          )}

          {phase === "choose" && ident && (
            <motion.div key="choose" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={EXIT} transition={ENTER_T} onAnimationStart={(def) => def !== EXIT && flow.release()} className="space-y-3">
              {ident.video && (
                <p className="px-1 text-sm text-muted-foreground" data-testid="choose-from">
                  From ‘{ident.video.title}’{ident.video.channel ? ` · ${ident.video.channel}` : ""}
                </p>
              )}
              <CandidatePicker
                key={`low-${ident.ticket ?? ident.parsed.title}`}
                heading="Which song is this?"
                headingRef={focusRef("picker")}
                candidates={ident.candidates}
                typed={typedDefaults(ident)}
                busy={working}
                note={
                  ident.mb === "busy"
                    ? "MusicBrainz is busy. Type the song, or try again in a minute."
                    : ident.candidates.length
                      ? null
                      : "We couldn't find it on MusicBrainz. Type the song:"
                }
                onPick={(c) => open({ artist: c.artist, title: c.title, year: c.year, mbid: c.mbid }, { video: ident.video, variant: ident.parsed.variant, candidate: c, ident }, "alternative")}
                onType={(s) => void identify(songQuery(s), "typed", { typeIt: true })}
              />
              <div className="flex justify-center">
                <Button variant="ghost" className="h-11 text-muted-foreground" onClick={reset}>
                  <RotateCcw /> New search
                </Button>
              </div>
            </motion.div>
          )}

          {phase === "song" && shown && (
            <motion.div key="song" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={EXIT} transition={ENTER_T} onAnimationStart={(def) => def !== EXIT && flow.release()} className="space-y-4">
              <SongCard
                song={shown.song}
                video={shown.video}
                variant={shown.variant}
                listen={data?.listen ?? null}
                shared={shared}
                picking={picking}
                pickerId="sample-picker"
                titleRef={focusRef("song")}
                notThisRef={focusRef("notThis")}
                onShare={share}
                onReset={reset}
                onNotThis={() => {
                  trackSamples({ name: "samples_not_this_song" });
                  focusNext.current = picking ? "notThis" : "picker";
                  setPicking((p) => !p);
                }}
              />
              <AnimatePresence initial={false}>
                {picking && (
                  <motion.div key="picker" id="sample-picker" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={FADE_EXIT} transition={ENTER_T}>
                    <CandidatePicker
                      heading="Not this song? Pick another"
                      headingRef={focusRef("picker")}
                      candidates={shown.ident?.candidates ?? []}
                      current={shown.song.mbid}
                      typed={{ artist: shown.song.artist, title: shown.song.title }}
                      busy={working}
                      onPick={(c) =>
                        open({ artist: c.artist, title: c.title, year: c.year, mbid: c.mbid }, { video: shown.video, variant: shown.variant, candidate: c, ident: shown.ident }, "alternative")
                      }
                      onType={(s) => void identify(songQuery(s), "typed", { typeIt: true })}
                      onCancel={() => {
                        focusNext.current = "notThis";
                        setPicking(false);
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <section aria-label="Results" className="rounded-3xl border border-border bg-card p-4 shadow-xl shadow-primary/5 sm:p-5" data-testid="results" data-state={results.state}>
                <ResultNotes
                  results={results}
                  note={note}
                  tier={tier}
                  remaining={remaining}
                  onRetry={() => {
                    // The note goes as it runs: focus waits on the song's title.
                    focusNext.current = "song";
                    if (shown.ident && !shown.song.mbid) void identify(text || songQuery(shown.song), "auto");
                    else void lookup(shown);
                  }}
                  onUpsell={() => setUpsell(true)}
                />
                {results.state === "loading" && relations.length === 0 ? (
                  <div className="space-y-3 py-2" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex gap-3">
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-3 w-3/5 rounded" />
                          <Skeleton className="h-3 w-2/5 rounded" />
                        </div>
                        <Skeleton className="h-11 w-24 rounded-lg" />
                      </div>
                    ))}
                  </div>
                ) : results.state !== "idle" && (relations.length > 0 || unchecked === null) ? (
                  <RelationTabs
                    song={shown.song}
                    relations={relations}
                    counts={counts}
                    tab={tab}
                    unchecked={unchecked}
                    onTab={changeTab}
                    onListen={(r) => trackSamples({ name: "samples_listen", role: r.role })}
                    onExplore={explore}
                  />
                ) : null}
                <p className="sr-only" aria-live="polite" data-testid="results-summary">
                  {summary}
                </p>
              </section>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {error && (
          <InlineError key="error" message={error.message}>
            {error.typeIt && phase !== "song" && (
              <button
                type="button"
                className={cn(pillAction, focusRing)}
                onClick={() => {
                  setError(null);
                  setIdent({
                    source: "text",
                    video: null,
                    parsed: { ...parseTyped(""), title: "" },
                    candidates: [],
                    pick: null,
                    confidence: 0,
                    band: "low",
                    catalog: [],
                    mb: "ok",
                    ticket: null,
                  });
                  focusNext.current = "picker";
                  setPhase("choose");
                }}
              >
                Type it
              </button>
            )}
          </InlineError>
        )}
      </AnimatePresence>

      <p className="text-center text-xs text-muted-foreground">
        We read the video&apos;s title; we never download it. Data from MusicBrainz and our hand-checked list.
      </p>

      {upsell && <UpgradeDialog open onOpenChange={(o) => !o && setUpsell(false)} reason="samples" tier={tier} returnTo={shown ? shareHref(shown.song, tab) : pathname} />}
    </div>
  );
}

/** Above the tabs: still checking, MusicBrainz busy or without the song, the day's lookups used, or an error. */
function ResultNotes({
  results,
  note,
  tier,
  remaining,
  onRetry,
  onUpsell,
}: {
  results: Results;
  note: string | null;
  tier: Tier;
  remaining: number | null;
  onRetry: () => void;
  onUpsell: () => void;
}) {
  const box = "mb-3 flex flex-wrap items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm";
  return (
    <AnimatePresence initial={false} mode="wait">
      {results.state === "loading" && (
        <motion.p key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mb-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid="checking">
          {/* CSS, so it keeps turning while the page is busy. */}
          <Disc3 className="h-4 w-4 motion-safe:animate-glyph" aria-hidden /> Checking MusicBrainz…
        </motion.p>
      )}
      {results.state === "busy" && (
        <motion.div key="busy" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={FADE_EXIT} transition={NOTICE_T} className={cn(box, "bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200")} data-testid="busy-note">
          <span className="flex-1">{note}</span>
          <button type="button" onClick={onRetry} className={cn("inline-flex min-h-11 items-center rounded-lg px-2 font-semibold underline", focusRing)}>
            Try again
          </button>
        </motion.div>
      )}
      {results.state === "off" && (
        <motion.p key="off" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mb-3 text-sm text-muted-foreground" data-testid="off-note">
          {note}
        </motion.p>
      )}
      {results.state === "done" && note && (
        <motion.p key="missing" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={FADE_EXIT} transition={NOTICE_T} className={cn(box, "bg-secondary")} data-testid="missing-note">
          {note}
        </motion.p>
      )}
      {results.state === "limit" && (
        <motion.button
          key="limit"
          type="button"
          data-testid="limit-banner"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={FADE_EXIT}
          transition={NOTICE_T}
          onClick={onUpsell}
          className={cn(box, "min-h-11 w-full border border-amber-300/60 bg-amber-50 text-left text-amber-900 dark:bg-amber-950/30 dark:text-amber-200", focusRing)}
        >
          <Crown className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <span className="flex-1">{note}</span>
          <span className="font-semibold underline">{tier === "pro" || tier === "team" ? "See plans" : "Get more"}</span>
        </motion.button>
      )}
      {results.state === "error" && (
        <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T}>
          <InlineError message={results.message} className="mb-3">
            <button type="button" onClick={onRetry} className={cn(pillAction, focusRing)}>
              Try again
            </button>
          </InlineError>
        </motion.div>
      )}
      {results.state === "done" && !note && remaining !== null && remaining <= 3 && (
        <motion.p key="left" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={FADE_EXIT} transition={NOTICE_T} className="mb-3 text-xs text-muted-foreground" data-testid="lookups-left">
          {remaining === 0 ? "No lookups left today." : `${remaining} ${remaining === 1 ? "lookup" : "lookups"} left today.`}
        </motion.p>
      )}
    </AnimatePresence>
  );
}
