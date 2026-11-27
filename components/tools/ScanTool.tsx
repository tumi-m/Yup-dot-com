"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Download,
  FileText,
  ImagePlus,
  Loader2,
  Maximize,
  Pencil,
  RotateCcw,
  RotateCw,
  Timer,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolDropzone } from "@/components/ui/dropzone";
import { ENTER, EXIT, FADE_EXIT, HANDOFF, InlineError, NOTICE_T, PROGRESS_HOLD_MS } from "@/components/motion/primitives";
import { ProgressBar, ProgressPercent, WorkingGlyph } from "@/components/motion/Progress";
import { resultFloor, settleSlot, settleTarget, scrollBehavior, useFocusNext, useHeightLock } from "@/components/motion/focus";
import { UpgradeDialog, UpsellCard, useSuccessNudge, type UpsellReason } from "@/components/upsell/Upsell";
import { SuccessCard } from "./SuccessCard";
import { QrCode } from "./QrCode";
import { placeholderSize, ToolPlaceholder } from "./panel-spec";
import { downloadBlob } from "@/lib/download";
import { trackToolUsed } from "@/lib/analytics";
import { formatLimitBytes, limitsFor, type Tier } from "@/lib/limits";
import { fileToHandoff, tryHandoff } from "@/lib/local-store";
import { dismissUpsellCard, recordTask, upsellCardDismissed } from "@/lib/nudge";
import { isAbort } from "@/lib/abort";
import { OCR_LANGUAGES } from "@/lib/pdf/ocr-languages";
import type { RawImage } from "@/lib/image-codec";
import { CORNER_NAMES, describeCorner, insetQuad, moveCorner, nudgeCorner, type Quad } from "@/lib/pdf/scan/geometry";
import { FILTERS, type ScanFilter } from "@/lib/pdf/scan/filters";
import { flattenPage, PAGE_SIZES, type ScanPageSize } from "@/lib/pdf/scan/page";
import { canUseCamera, cameraProblem, loadedElsewhere, openCamera, stopStream } from "@/lib/pdf/scan/camera";
import { paint, photoFromFile, photoFromVideo, photoPixels, thumbnailUrl, type Photo } from "@/lib/pdf/scan/photo";
import { cn, formatBytes } from "@/lib/utils";

/** Where a scan can go next. Searchable scans skip OCR. */
const NEXT_STEPS = ["compress-pdf", "ocr-pdf", "merge-pdf", "sign-pdf"];

interface Page {
  id: number;
  /** Bumps when the photo is retaken, so its editor starts afresh. */
  shot: number;
  photo: Photo;
  quad: Quad;
  filter: ScanFilter;
  /** Clockwise degrees. */
  rotation: number;
  /** A small picture of the flattened page (object URL), once made. */
  thumb: string | null;
}

type View = { kind: "pages" } | { kind: "camera"; replace: number | null } | { kind: "edit"; id: number; fresh: boolean };

interface Result {
  blob: Blob;
  name: string;
  pages: number;
  words: number | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A phone or tablet: a finger is the pointer and nothing hovers. */
function usePhone(): boolean {
  return useSyncExternalStore(
    (on) => {
      const mq = window.matchMedia("(hover: none) and (pointer: coarse)");
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    },
    () => window.matchMedia("(hover: none) and (pointer: coarse)").matches,
    () => false
  );
}

/** Labelled radio pills: native radios, so arrow keys move between them. */
function Pills<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  describedBy,
}: {
  name: string;
  legend: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  describedBy?: string;
}) {
  return (
    <fieldset className="min-w-0" aria-describedby={describedBy}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "inline-flex min-h-9 cursor-pointer items-center rounded-full border px-3 text-sm transition-colors pointer-coarse:min-h-11 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
              value === o.value ? "border-primary bg-primary/10 font-medium text-primary" : "border-border bg-background hover:bg-accent"
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const PAGE_SIZE_HINT: Record<ScanPageSize, string> = {
  fit: "Each page the shape of the paper scanned.",
  a4: "Each scan on an A4 sheet, turned to suit it.",
  letter: "Each scan on a US Letter sheet, turned to suit it.",
};

export function ScanTool({ slug, tier }: { slug: string; tier: Tier }) {
  const router = useRouter();
  const limits = limitsFor(tier);
  const phone = usePhone();
  const reduce = useReducedMotion();
  const photosRef = useRef<HTMLInputElement>(null);
  const shootRef = useRef<HTMLInputElement>(null);

  const [pages, setPages] = useState<Page[]>([]);
  const [view, setView] = useState<View>({ kind: "pages" });
  /** Set after mount: whether this browser offers the live camera here. */
  const [camera, setCamera] = useState<boolean | null>(null);
  const [adding, setAdding] = useState(false);
  const [pageSize, setPageSize] = useState<ScanPageSize>("fit");
  const [searchable, setSearchable] = useState(false);
  const [lang, setLang] = useState("eng");
  /** The filter new pages start with: the last one picked. */
  const [lastFilter, setLastFilter] = useState<ScanFilter>("color");
  const [status, setStatus] = useState<"ready" | "working" | "done">("ready");
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const [error, setError] = useState<{ message: string; photo?: boolean } | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [downloaded, setDownloaded] = useState(false);
  const [upsell, setUpsell] = useState<UpsellReason | null>(null);
  const [showCard, setShowCard] = useState(false);
  const [nextFailed, setNextFailed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const nudge = useSuccessNudge(() => setUpsell("nudge"));
  const { next: focusNext, focusRef } = useFocusNext<"done" | "run" | "progress" | "start" | "shutter" | "editor" | "add" | `page-${number}` | `earlier-${number}` | `later-${number}`>();
  const flow = useHeightLock<HTMLDivElement>();
  const job = useRef<AbortController | null>(null);
  const ids = useRef(0);
  /** The page a photo from the file picker replaces, when Retake opened it. */
  const retaking = useRef<number | null>(null);

  // Object URLs of thumbnails live until their page goes, or the tool does.
  const pagesRef = useRef<Page[]>([]);
  pagesRef.current = pages;
  useEffect(
    () => () => {
      job.current?.abort();
      for (const p of pagesRef.current) if (p.thumb) URL.revokeObjectURL(p.thumb);
    },
    []
  );

  useEffect(() => {
    const live = canUseCamera();
    setCamera(live);
    // The camera is allowed by this page's own headers. Arriving by a link
    // inside the site keeps the first page's (camera off): load this one.
    // Only then, so a page still blocked after loading (inside a frame) can't reload forever.
    if (!live || !loadedElsewhere(`/tools/${slug}`)) return;
    const policy = (document as Document & { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
    if (!policy || !policy.allowsFeature("camera")) window.location.replace(window.location.href);
  }, [slug]);

  // A new view (editor, tray, camera) is brought into sight with its focus: the one before can be much longer, and focus moves without scrolling.
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    const root = flow.ref.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    // The editor and the camera start at the top of the screen, so their buttons are in reach.
    if (view.kind !== "pages") {
      const target = settleTarget(top, window.scrollY, window.innerHeight);
      if (target !== null) window.scrollTo({ top: target, behavior: scrollBehavior() });
      return;
    }
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || !root.contains(el)) return;
    const r = el.getBoundingClientRect();
    if (r.top >= 80 && r.bottom <= window.innerHeight) return;
    // The tray's top when that keeps the focused control on screen, else the control itself.
    const target = settleTarget(r.bottom - top + 96 <= window.innerHeight ? top : r.top, window.scrollY, window.innerHeight);
    if (target !== null) window.scrollTo({ top: target, behavior: scrollBehavior() });
  }, [view, flow.ref]);

  function say(message: string) {
    setNote((prev) => (prev === message ? `${message} ` : message));
  }

  function fail(message: string | null, photo = false) {
    setError(message ? { message, photo } : null);
    if (message) setErrorKey((k) => k + 1);
  }

  const room = limits.maxBatchFiles - pages.length;

  /** A thumbnail for a page, made from its photo; replaces the old one. */
  async function makeThumb(page: Page, pixels?: RawImage) {
    try {
      const px = pixels ?? (await photoPixels(page.photo, 720));
      const url = await thumbnailUrl(px, page);
      setPages((list) => {
        const at = list.find((p) => p.id === page.id);
        // The page went, or changed again, while this was made.
        if (!at || at.photo !== page.photo || at.quad !== page.quad || at.filter !== page.filter || at.rotation !== page.rotation) {
          URL.revokeObjectURL(url);
          return list;
        }
        if (at.thumb) URL.revokeObjectURL(at.thumb);
        return list.map((p) => (p.id === page.id ? { ...p, thumb: url } : p));
      });
    } catch {
      // The tray shows the page's number without a picture.
    }
  }

  function newPage(photo: Photo): Page {
    return { id: ++ids.current, shot: ++ids.current, photo, quad: photo.quad, filter: lastFilter, rotation: 0, thumb: null };
  }

  /** At the page limit: says so and offers more. */
  function full(): boolean {
    if (room > 0) return false;
    setUpsell("batch");
    fail(`Up to ${limits.maxBatchFiles} pages a scan on your plan.`);
    return true;
  }

  // -------------------------------------------------------------------------
  // Adding pages
  // -------------------------------------------------------------------------

  function openCameraView(replace: number | null = null) {
    if (replace === null && full()) return;
    fail(null);
    if (!camera) {
      // The camera app (or a photo) instead; a retake replaces its page.
      retaking.current = replace;
      (phone ? shootRef : photosRef).current?.click();
      return;
    }
    focusNext.current = "shutter";
    setView({ kind: "camera", replace });
  }

  async function addFiles(list: FileList | File[] | null) {
    const replace = retaking.current;
    retaking.current = null;
    if (!list?.length) return;
    fail(null);
    const files = Array.from(list);
    if (replace !== null && pagesRef.current.some((p) => p.id === replace)) {
      const file = files[0];
      if (file.size > limits.maxFileBytes) {
        setUpsell("file-size");
        return fail(`Photos up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
      }
      setAdding(true);
      try {
        await captured(await photoFromFile(file), replace);
      } catch (err) {
        fail(err instanceof Error ? err.message : "This picture couldn't be opened.");
      } finally {
        setAdding(false);
      }
      return;
    }
    const pictures = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|avif|gif|bmp)$/i.test(f.name));
    if (!pictures.length) return fail("Scan to PDF takes photos: JPG, PNG, WebP or HEIC.");
    const tooBig = pictures.filter((f) => f.size > limits.maxFileBytes);
    if (tooBig.length) {
      setUpsell("file-size");
      fail(`Photos up to ${formatLimitBytes(limits.maxFileBytes)} on your plan.`);
    }
    const fits = pictures.filter((f) => f.size <= limits.maxFileBytes);
    const take = fits.slice(0, Math.max(0, room));
    if (fits.length > take.length) {
      setUpsell("batch");
      fail(`Up to ${limits.maxBatchFiles} pages a scan on your plan: ${plural(fits.length - take.length, "photo")} left out.`);
    }
    if (!take.length) return;
    setAdding(true);
    const added: Page[] = [];
    const problems: string[] = [];
    for (const file of take) {
      try {
        const page = newPage(await photoFromFile(file));
        added.push(page);
        setPages((list) => [...list, page]);
        void makeThumb(page);
      } catch (err) {
        problems.push(`${file.name}: ${err instanceof Error ? err.message : "this picture couldn't be opened."}`);
      }
    }
    setAdding(false);
    if (problems.length) fail(problems.join(" "));
    if (!added.length) return;
    const unfound = added.filter((p) => !p.photo.found).length;
    say(`${plural(added.length, "page")} added.${unfound ? ` Check the corners of ${plural(unfound, "page")}: the edges weren't found.` : ""}`);
    // One photo: check its corners now. Several: the tray, to look them over.
    if (take.length === 1 && added.length === 1) {
      focusNext.current = "editor";
      setView({ kind: "edit", id: added[0].id, fresh: false });
    } else {
      focusNext.current = `page-${added[0].id}`;
    }
  }

  async function captured(photo: Photo, replace: number | null) {
    const old = replace === null ? undefined : pagesRef.current.find((p) => p.id === replace);
    if (old) {
      if (old.thumb) URL.revokeObjectURL(old.thumb);
      const updated: Page = { ...old, shot: ++ids.current, photo, quad: photo.quad, thumb: null };
      setPages((list) => list.map((p) => (p.id === old.id ? updated : p)));
      focusNext.current = "editor";
      setView({ kind: "edit", id: old.id, fresh: false });
      void makeThumb(updated);
      return;
    }
    const page = newPage(photo);
    setPages((list) => [...list, page]);
    focusNext.current = "editor";
    setView({ kind: "edit", id: page.id, fresh: true });
    void makeThumb(page);
  }

  // -------------------------------------------------------------------------
  // The tray
  // -------------------------------------------------------------------------

  function update(id: number, change: Partial<Pick<Page, "quad" | "filter" | "rotation">>, pixels?: RawImage) {
    const cur = pagesRef.current.find((p) => p.id === id);
    if (!cur) return;
    const next: Page = { ...cur, ...change };
    pagesRef.current = pagesRef.current.map((p) => (p.id === id ? next : p));
    setPages((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p)));
    if (change.filter) setLastFilter(change.filter);
    void makeThumb(next, pixels);
  }

  function remove(id: number) {
    const at = pages.findIndex((p) => p.id === id);
    if (at < 0) return;
    const gone = pages[at];
    if (gone.thumb) URL.revokeObjectURL(gone.thumb);
    const rest = pages.filter((p) => p.id !== id);
    setPages(rest);
    say(`Page ${at + 1} deleted. ${plural(rest.length, "page")} left.`);
    // Focus the page that took its place, or the one before, or Add.
    const next = rest[at] ?? rest[at - 1];
    focusNext.current = next ? `page-${next.id}` : "start";
    setView({ kind: "pages" });
  }

  /** `button`: moved with a Move button, which keeps focus unless the page reached the end it points to; then the other one has it. */
  function move(id: number, by: number, button?: "earlier" | "later") {
    const from = pages.findIndex((p) => p.id === id);
    const to = Math.max(0, Math.min(pages.length - 1, from + by));
    if (from < 0 || to === from) return;
    const list = [...pages];
    const [page] = list.splice(from, 1);
    list.splice(to, 0, page);
    setPages(list);
    say(`Page moved to ${to + 1} of ${list.length}.`);
    if (button === "earlier") focusNext.current = to === 0 ? `later-${id}` : `earlier-${id}`;
    if (button === "later") focusNext.current = to === list.length - 1 ? `earlier-${id}` : `later-${id}`;
  }

  function dropOn(targetId: number) {
    if (dragging === null || dragging === targetId) return;
    const from = pages.findIndex((p) => p.id === dragging);
    const to = pages.findIndex((p) => p.id === targetId);
    if (from >= 0 && to >= 0) move(dragging, to - from);
    setDragging(null);
  }

  // -------------------------------------------------------------------------
  // Making the PDF
  // -------------------------------------------------------------------------

  async function run() {
    if (!pages.length) return;
    if (pages.length > limits.maxBatchFiles) {
      setUpsell("batch");
      return fail(`Up to ${limits.maxBatchFiles} pages a scan on your plan.`);
    }
    if (document.activeElement?.closest("[data-cast]")) focusNext.current = "progress";
    flow.lock(resultFloor());
    setStatus("working");
    fail(null);
    setProgress(null);
    setNextFailed(null);
    const started = performance.now();
    const ctl = new AbortController();
    job.current = ctl;
    try {
      const { scanToPdf, scanName } = await import("@/lib/pdf/scan/run");
      const done = await scanToPdf(
        pages.map((p) => ({ image: p.photo.blob, quad: p.quad, filter: p.filter, rotation: p.rotation })),
        { pageSize, ocr: searchable ? lang : null },
        { progress: (fraction, label) => !ctl.signal.aborted && setProgress({ fraction, label }), signal: ctl.signal }
      );
      if (ctl.signal.aborted) return;
      const seconds = (performance.now() - started) / 1000;
      setProgress((p) => ({ fraction: 1, label: p?.label ?? "Casting…" }));
      if (!reduce) await new Promise((r) => setTimeout(r, PROGRESS_HOLD_MS));
      if (ctl.signal.aborted) return;
      setResult({
        blob: new Blob([done.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
        name: scanName(),
        pages: done.pages,
        words: done.words,
      });
      setDownloaded(false);
      setElapsed(seconds);
      if (focusNext.current || document.activeElement?.closest("[data-progress]") || document.activeElement === document.body) {
        focusNext.current = "done";
      }
      settleSlot(flow.ref.current);
      setStatus("done");
      trackToolUsed(slug);
      setShowCard(!upsellCardDismissed());
      if (recordTask(tier === "guest")) nudge.arm();
    } catch (err) {
      if (ctl.signal.aborted || isAbort(err)) return;
      fail(err instanceof Error ? err.message : "Something went wrong. Try again.");
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

  /** Back from the result to the pages, as they were left. */
  function backToPages() {
    nudge.cancel();
    flow.lock();
    setResult(null);
    focusNext.current = "run";
    setStatus("ready");
  }

  function reset() {
    job.current?.abort();
    nudge.cancel();
    for (const p of pages) if (p.thumb) URL.revokeObjectURL(p.thumb);
    if (flow.ref.current?.contains(document.activeElement)) focusNext.current = "start";
    if (status === "done") flow.lock();
    else flow.release();
    setPages([]);
    setResult(null);
    setView({ kind: "pages" });
    fail(null);
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

  const working = status === "working";
  const editing = view.kind === "edit" ? pages.find((p) => p.id === view.id) ?? null : null;
  const overLimit = !!result && result.blob.size > limits.maxFileBytes;
  const takePhotoLabel = phone ? "Take a photo" : "Choose photos";
  const takePhoto = () => {
    retaking.current = null;
    (phone ? shootRef : photosRef).current?.click();
  };
  const pickPhotos = () => {
    retaking.current = null;
    photosRef.current?.click();
  };

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {note}
      </p>
      {/* Photos from the gallery or files; and one from the camera app, where the live camera can't run. */}
      <input
        ref={photosRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        data-testid="photos-input"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={shootRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-hidden
        tabIndex={-1}
        data-testid="shoot-input"
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
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
                    {plural(result.pages, "page")} · {formatBytes(result.blob.size)}
                  </span>
                  {result.words !== null && (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium",
                        result.words ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                      )}
                    >
                      {result.words ? `Searchable: ${plural(result.words, "word")} read` : "No text could be read, so it isn't searchable"}
                    </span>
                  )}
                </>
              }
              actions={
                <>
                  <Button onClick={saveResult} size="lg" className="min-w-44 shadow-lg shadow-primary/25" data-testid="download">
                    <Download /> Download
                  </Button>
                  <Button onClick={backToPages} variant="outline" size="lg">
                    <Pencil /> Back to pages
                  </Button>
                  <Button onClick={reset} variant="ghost" size="lg">
                    <RotateCcw /> Start over
                  </Button>
                </>
              }
              next={
                overLimit
                  ? undefined
                  : { slugs: NEXT_STEPS.filter((s) => !(s === "ocr-pdf" && result.words)), onPick: (next) => void continueWith(next), failed: nextFailed }
              }
              nextNote={
                overLimit ? (
                  <>
                    Over {formatLimitBytes(limits.maxFileBytes)}, the limit on your plan: download it first.{" "}
                    <button type="button" className="underline underline-offset-2" onClick={() => setUpsell("file-size")}>
                      Get more room
                    </button>
                  </>
                ) : undefined
              }
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
              {view.kind === "camera" ? (
                <CameraView
                  shutterRef={focusRef("shutter")}
                  count={pages.length}
                  replacing={view.replace !== null}
                  lastThumb={pages[pages.length - 1]?.thumb ?? null}
                  onCapture={(photo) => void captured(photo, view.replace)}
                  onClose={() => {
                    focusNext.current = view.replace !== null ? `page-${view.replace}` : pages.length ? "run" : "start";
                    setView({ kind: "pages" });
                  }}
                  onProblem={(err) => {
                    const problem = cameraProblem(err, phone);
                    fail(problem.message, !problem.noCamera);
                    if (problem.noCamera || problem.refused) setCamera(false);
                    focusNext.current = "start";
                    setView({ kind: "pages" });
                  }}
                />
              ) : editing && view.kind === "edit" ? (
                <PageEditor
                  key={editing.shot}
                  headingRef={focusRef("editor")}
                  page={editing}
                  index={pages.indexOf(editing)}
                  count={pages.length}
                  fresh={view.fresh}
                  canAdd={room > 0}
                  onChange={(change, pixels) => update(editing.id, change, pixels)}
                  onRetake={() => {
                    if (view.fresh) {
                      // Not kept: that photo is thrown away.
                      if (editing.thumb) URL.revokeObjectURL(editing.thumb);
                      setPages((list) => list.filter((p) => p.id !== editing.id));
                      focusNext.current = "shutter";
                      setView({ kind: "camera", replace: null });
                    } else openCameraView(editing.id);
                  }}
                  onNext={() => {
                    say(`Page ${pages.indexOf(editing) + 1} kept.`);
                    if (full()) {
                      focusNext.current = "run";
                      setView({ kind: "pages" });
                      return;
                    }
                    focusNext.current = "shutter";
                    setView({ kind: "camera", replace: null });
                  }}
                  onDone={() => {
                    focusNext.current = view.fresh ? "run" : `page-${editing.id}`;
                    setView({ kind: "pages" });
                  }}
                  onDelete={() => remove(editing.id)}
                />
              ) : !pages.length && camera === null ? (
                // Phone or computer is known once on the device: no flash of the other layout.
                <ToolPlaceholder className={placeholderSize("scan")} />
              ) : !pages.length ? (
                <StartPanel
                  phone={phone}
                  camera={camera}
                  adding={adding}
                  startRef={focusRef("start")}
                  limit={limits.maxFileBytes}
                  onCamera={() => openCameraView()}
                  onPhotos={pickPhotos}
                  onFiles={(files) => void addFiles(files)}
                />
              ) : (
                <fieldset disabled={working} className="min-w-0 space-y-4">
                  <legend className="sr-only">Pages</legend>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium tabular-nums" data-testid="page-count">
                      {plural(pages.length, "page")}
                      <span className="font-normal text-muted-foreground"> · up to {limits.maxBatchFiles}</span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button ref={focusRef("start")} size="sm" variant="secondary" className="pointer-coarse:h-11" onClick={() => openCameraView()} disabled={adding}>
                        {camera || phone ? <Camera /> : <ImagePlus />} {camera ? "Scan more" : takePhotoLabel}
                      </Button>
                      <Button ref={focusRef("add")} size="sm" variant="outline" className="pointer-coarse:h-11" onClick={pickPhotos} disabled={adding}>
                        {adding ? <Loader2 className="motion-safe:animate-spin" /> : <ImagePlus />} Add photos
                      </Button>
                    </div>
                  </div>
                  <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3" aria-label="Pages, in order" data-testid="tray">
                    {pages.map((p, i) => (
                      <li
                        key={p.id}
                        draggable={!working}
                        onDragStart={(e) => {
                          setDragging(p.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragOver={(e) => {
                          if (dragging !== null) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          dropOn(p.id);
                        }}
                        onDragEnd={() => setDragging(null)}
                        className={cn("rounded-xl border bg-card p-1.5", dragging === p.id ? "border-dashed border-primary opacity-60" : "border-border")}
                        data-testid="tray-page"
                      >
                        <button
                          type="button"
                          ref={focusRef(`page-${p.id}`)}
                          onClick={() => {
                            focusNext.current = "editor";
                            setView({ kind: "edit", id: p.id, fresh: false });
                          }}
                          onKeyDown={(e) => {
                            if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowUp")) {
                              e.preventDefault();
                              move(p.id, -1);
                            } else if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowDown")) {
                              e.preventDefault();
                              move(p.id, 1);
                            }
                          }}
                          aria-label={`Page ${i + 1} of ${pages.length}${p.rotation ? `, turned ${p.rotation}°` : ""}${p.photo.found ? "" : ", edges not found"}. Edit`}
                          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                          className="group relative block w-full overflow-hidden rounded-lg bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        >
                          <span className="flex aspect-[3/4] items-center justify-center">
                            {p.thumb ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={p.thumb} alt="" className="max-h-full max-w-full object-contain shadow-sm" draggable={false} />
                            ) : (
                              <Loader2 className="h-5 w-5 text-muted-foreground motion-safe:animate-spin" aria-hidden />
                            )}
                          </span>
                          <span className="absolute left-1.5 top-1.5 rounded-md bg-background/90 px-1.5 text-xs font-semibold tabular-nums shadow">{i + 1}</span>
                          {!p.photo.found && (
                            <span className="absolute inset-x-1.5 bottom-1.5 rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">Check corners</span>
                          )}
                          <span className="absolute right-1.5 top-1.5 rounded-md bg-background/90 p-1 opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 hover-none:opacity-100">
                            <Pencil className="h-3.5 w-3.5" aria-hidden />
                          </span>
                        </button>
                        <div className="mt-1.5 flex justify-between gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-9 w-9 p-0 pointer-coarse:h-11 pointer-coarse:w-11"
                            ref={focusRef(`earlier-${p.id}`)}
                            onClick={() => move(p.id, -1, "earlier")}
                            disabled={i === 0}
                            aria-label={`Move page ${i + 1} earlier`}
                          >
                            <ArrowLeft />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-9 w-9 p-0 pointer-coarse:h-11 pointer-coarse:w-11"
                            ref={focusRef(`later-${p.id}`)}
                            onClick={() => move(p.id, 1, "later")}
                            disabled={i === pages.length - 1}
                            aria-label={`Move page ${i + 1} later`}
                          >
                            <ArrowRight />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-9 w-9 p-0 text-destructive pointer-coarse:h-11 pointer-coarse:w-11"
                            onClick={() => remove(p.id)}
                            aria-label={`Delete page ${i + 1}`}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <p className="text-center text-xs text-muted-foreground">
                    <span className="hover-none:hidden">Drag pages to reorder, or Alt + arrow keys on a page.</span>
                    <span className="hidden hover-none:inline">Tap a page to check its corners and colour.</span>
                  </p>

                  <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
                    <Pills<ScanPageSize> name="scan-size" legend="Page size" value={pageSize} options={PAGE_SIZES} onChange={setPageSize} describedBy="scan-size-hint" />
                    <p id="scan-size-hint" className="-mt-2 text-xs text-muted-foreground">
                      {PAGE_SIZE_HINT[pageSize]}
                    </p>
                    <div className="border-t border-border pt-3">
                      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium sm:min-h-10">
                        <input
                          type="checkbox"
                          checked={searchable}
                          onChange={(e) => setSearchable(e.target.checked)}
                          aria-describedby="scan-ocr-hint"
                          className="h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-[hsl(var(--primary))]"
                          data-testid="searchable"
                        />
                        Make it searchable
                      </label>
                      <p id="scan-ocr-hint" className="pl-[30px] text-xs text-muted-foreground">
                        {searchable
                          ? "The text is read on your device and laid invisibly over each page, so you can search and copy it. It takes a few seconds a page."
                          : "Off: the pages are pictures only."}
                      </p>
                      {searchable && (
                        <div className="mt-3 pl-[30px] sm:max-w-xs">
                          <label htmlFor="scan-lang" className="mb-1 block text-xs text-muted-foreground">
                            Document language
                          </label>
                          <select
                            id="scan-lang"
                            value={lang}
                            onChange={(e) => setLang(e.target.value)}
                            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-base pointer-coarse:h-11 sm:text-sm"
                          >
                            {OCR_LANGUAGES.map((l) => (
                              <option key={l.value} value={l.value}>
                                {l.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                </fieldset>
              )}

              <AnimatePresence>
                {error && view.kind !== "camera" && (
                  <InlineError key="error" shakeKey={errorKey} message={error.message}>
                    {error.photo && (
                      <button type="button" className="ml-auto shrink-0 font-medium underline underline-offset-2" onClick={takePhoto}>
                        {takePhotoLabel}
                      </button>
                    )}
                  </InlineError>
                )}
              </AnimatePresence>

              {view.kind === "pages" && pages.length > 0 && (
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
                        <Button ref={focusRef("run")} size="lg" onClick={run} data-cast data-testid="run" className="min-w-52 shadow-lg shadow-primary/25" disabled={adding}>
                          <FileText /> Make PDF
                        </Button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  {!working && <p className="text-xs text-muted-foreground">Made on your device. Nothing is uploaded.</p>}
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

// ---------------------------------------------------------------------------
// Before the first page
// ---------------------------------------------------------------------------

function StartPanel({
  phone,
  camera,
  adding,
  startRef,
  limit,
  onCamera,
  onPhotos,
  onFiles,
}: {
  phone: boolean;
  camera: boolean | null;
  adding: boolean;
  startRef: (el: HTMLElement | null) => void;
  limit: number;
  onCamera: () => void;
  onPhotos: () => void;
  onFiles: (files: FileList) => void;
}) {
  const [here, setHere] = useState("");
  useEffect(() => setHere(`${window.location.origin}${window.location.pathname}`), []);
  const buttons = (
    <div className="flex flex-wrap justify-center gap-2">
      <Button ref={startRef} className="h-11" onClick={onCamera} disabled={adding} data-testid="open-camera">
        {/* With no camera on a computer it opens the file picker, and looks it. */}
        {camera === false && !phone ? <ImagePlus /> : <Camera />} {camera === false ? (phone ? "Take a photo" : "Choose photos") : phone ? "Open camera" : "Use webcam"}
      </Button>
      {(camera !== false || phone) && (
        <Button variant="outline" className="h-11" onClick={onPhotos} disabled={adding} data-testid="choose-photos">
          {adding ? <Loader2 className="motion-safe:animate-spin" /> : <ImagePlus />} Choose photos
        </Button>
      )}
    </div>
  );
  const fine = <p className="mt-4 text-xs text-muted-foreground">Photos up to {formatLimitBytes(limit)} · Stays on your device.</p>;

  if (phone) {
    return (
      <div className="rounded-3xl border-2 border-dashed border-border bg-card p-8 text-center" data-testid="scan-start">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Camera className="h-7 w-7" aria-hidden />
        </span>
        <p className="mb-4 text-sm text-muted-foreground">Lay the page flat in good light, then take a photo of it.</p>
        {buttons}
        {fine}
      </div>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" data-testid="scan-start">
      <div className="flex flex-col items-center rounded-3xl border border-border bg-card p-6 text-center">
        <p className="text-sm font-semibold">Works best on a phone</p>
        <p className="mt-1 text-xs text-muted-foreground">Point your phone&apos;s camera at this code to open this page there.</p>
        {here && <QrCode text={here} label="QR code that opens Scan to PDF on your phone" className="mt-4 h-40 w-40 rounded-lg ring-1 ring-border" />}
      </div>
      <ToolDropzone label="Drop photos here" onFiles={onFiles} busy={adding} className="flex flex-col items-center justify-center p-6">
        <p className="mb-3 text-sm text-muted-foreground">or use this computer</p>
        {buttons}
        {fine}
      </ToolDropzone>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/**
 * The live camera with a shutter. The stream stops when this closes, when
 * the tab goes to the background (it starts again on return) and when the
 * page is left, so the camera light never stays on behind the visitor.
 */
function CameraView({
  shutterRef,
  count,
  replacing,
  lastThumb,
  onCapture,
  onClose,
  onProblem,
}: {
  shutterRef: (el: HTMLElement | null) => void;
  count: number;
  replacing: boolean;
  lastThumb: string | null;
  onCapture: (photo: Photo) => void;
  onClose: () => void;
  onProblem: (err: unknown) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"starting" | "live" | "paused">("starting");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(0);
  const [shotError, setShotError] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const problem = useRef(onProblem);
  problem.current = onProblem;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    const start = async () => {
      setState("starting");
      try {
        const s = await openCamera();
        if (!live || document.visibilityState === "hidden") {
          stopStream(s);
          return;
        }
        stream = s;
        const el = video.current;
        if (el) {
          el.srcObject = s;
          await el.play().catch(() => {});
        }
        setState("live");
      } catch (err) {
        if (live) problem.current(err);
      }
    };
    const stop = () => {
      stopStream(stream);
      stream = null;
      if (video.current) video.current.srcObject = null;
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") {
        stop();
        setState("paused");
      } else if (!stream) void start();
    };
    void start();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", stop);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, []);

  async function shoot() {
    const el = video.current;
    if (!el || state !== "live" || busy) return;
    setBusy(true);
    setShotError(null);
    setFlash((n) => n + 1);
    try {
      onCapture(await photoFromVideo(el));
    } catch (err) {
      setShotError(err instanceof Error ? err.message : "That photo didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div initial={ENTER.initial} animate={ENTER.animate} className="space-y-3" data-testid="camera">
      <div className="relative overflow-hidden rounded-2xl bg-black">
        <video
          ref={video}
          playsInline
          muted
          aria-label="Camera view"
          className="mx-auto block max-h-[65vh] w-full object-contain"
        />
        {state !== "live" && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> {state === "paused" ? "Camera paused" : "Starting the camera…"}
          </p>
        )}
        {!reduce && flash > 0 && (
          <motion.span key={flash} aria-hidden className="pointer-events-none absolute inset-0 bg-white" initial={{ opacity: 0.7 }} animate={{ opacity: 0 }} transition={{ duration: 0.25 }} />
        )}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <Button variant="ghost" className="h-11 justify-self-start" onClick={onClose}>
          <X /> {replacing ? "Cancel" : "Close"}
        </Button>
        <button
          ref={shutterRef}
          type="button"
          onClick={() => void shoot()}
          // Not disabled while the camera starts: focus waits on it there.
          aria-disabled={state !== "live" || busy}
          aria-label={replacing ? "Retake this page" : `Take photo of page ${count + 1}`}
          className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-primary bg-background shadow-lg transition-transform active:scale-95 aria-disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transform-none"
          data-testid="shutter"
        >
          {busy ? <Loader2 className="h-6 w-6 text-primary motion-safe:animate-spin" aria-hidden /> : <span className="h-11 w-11 rounded-full bg-primary" aria-hidden />}
        </button>
        <div className="flex items-center justify-self-end gap-2">
          {lastThumb && !replacing && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lastThumb} alt="" className="h-11 w-9 rounded object-cover ring-1 ring-border" />
          )}
          {count > 0 && !replacing && (
            <Button variant="secondary" className="h-11" onClick={onClose} data-testid="camera-done">
              <Check /> Done · {count}
            </Button>
          )}
        </div>
      </div>
      {shotError ? (
        <p role="alert" className="text-center text-sm text-destructive">
          {shotError}
        </p>
      ) : (
        <p className="text-center text-xs text-muted-foreground">Hold the phone over the page, with all four corners in view.</p>
      )}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// One page: corners, colour, turning
// ---------------------------------------------------------------------------

/** The corner view is at most this tall, so the buttons stay in reach on a phone. */
const MAX_VIEW_HEIGHT = 520;

function PageEditor({
  headingRef,
  page,
  index,
  count,
  fresh,
  canAdd,
  onChange,
  onRetake,
  onNext,
  onDone,
  onDelete,
}: {
  headingRef: (el: HTMLElement | null) => void;
  page: Page;
  index: number;
  count: number;
  /** Just taken with the camera: Next page and Retake lead back to it. */
  fresh: boolean;
  canAdd: boolean;
  onChange: (change: Partial<Pick<Page, "quad" | "filter" | "rotation">>, pixels?: RawImage) => void;
  onRetake: () => void;
  onNext: () => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const [pixels, setPixels] = useState<RawImage | null>(null);
  const [failed, setFailed] = useState(false);
  const [quad, setQuad] = useState<Quad>(page.quad);
  const [spoken, setSpoken] = useState("");
  const photoCanvas = useRef<HTMLCanvasElement>(null);
  const previewCanvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const drag = useRef<{ corner: number; id: number } | null>(null);
  const start = useRef(page.quad);

  // The photo, decoded at screen size while this page is open, and let go after.
  useEffect(() => {
    let live = true;
    photoPixels(page.photo)
      .then((px) => live && setPixels(px))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [page.photo]);

  useEffect(() => {
    const canvas = photoCanvas.current;
    if (canvas && pixels) paint(canvas, pixels);
  }, [pixels]);

  useEffect(() => {
    const a = photoCanvas.current;
    const b = previewCanvas.current;
    return () => {
      if (a) a.width = a.height = 0;
      if (b) b.width = b.height = 0;
    };
  }, []);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // The room inside the padding: measuring the box itself would let the photo widen it, again and again.
    const measure = () => {
      const css = getComputedStyle(el);
      setWidth(Math.max(0, el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  // The flattened page, redrawn shortly after the corners stop moving.
  useEffect(() => {
    if (!pixels) return;
    const t = setTimeout(() => {
      const canvas = previewCanvas.current;
      if (!canvas) return;
      try {
        paint(canvas, flattenPage(pixels, { quad, filter: page.filter, rotation: page.rotation }, 900));
      } catch {
        // Corners that make no page: the last preview stays.
      }
    }, 120);
    return () => clearTimeout(t);
  }, [pixels, quad, page.filter, page.rotation]);

  // The tray's picture follows once a drag or key run ends.
  const commit = useCallback(
    (q: Quad) => {
      if (q !== page.quad) onChange({ quad: q }, pixels ?? undefined);
    },
    [onChange, page.quad, pixels]
  );

  useEffect(() => {
    if (!spoken) return;
    const t = setTimeout(() => commit(quad), 400);
    return () => clearTimeout(t);
  }, [spoken, quad, commit]);

  const maxH = typeof window === "undefined" ? MAX_VIEW_HEIGHT : Math.min(MAX_VIEW_HEIGHT, Math.round(window.innerHeight * 0.5));
  const scale = width ? Math.min(width / page.photo.width, maxH / page.photo.height) : 0;
  const w = page.photo.width * scale;
  const h = page.photo.height * scale;

  function point(e: React.PointerEvent) {
    const r = wrap.current!.querySelector<HTMLElement>("[data-photo]")!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }

  const grab = (corner: number) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    drag.current = { corner, id: e.pointerId };
  };

  function moveTo(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const next = moveCorner(quad, d.corner, point(e));
    if (next) setQuad(next);
  }

  function drop(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    commit(quad);
  }

  function key(corner: number, e: React.KeyboardEvent) {
    const next = nudgeCorner(quad, corner, e);
    if (!next) return;
    e.preventDefault();
    setQuad(next);
    setSpoken(`${CORNER_NAMES[corner]} corner: ${describeCorner(next[corner])}.`);
  }

  function setCorners(q: Quad, message: string) {
    setQuad(q);
    onChange({ quad: q }, pixels ?? undefined);
    setSpoken(message);
  }

  const turn = (by: number) => onChange({ rotation: (((page.rotation + by) % 360) + 360) % 360 }, pixels ?? undefined);
  const whole: Quad = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  // On a phone the buttons come straight after the photo, with the preview and filters below them; from sm up, in the order they are read.
  return (
    <motion.section initial={ENTER.initial} animate={ENTER.animate} className="flex flex-col gap-4" aria-labelledby="scan-edit-title" data-testid="editor">
      <p className="sr-only" aria-live="polite">
        {spoken}
      </p>
      <div className="order-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 sm:order-none">
        <h2 id="scan-edit-title" ref={headingRef} tabIndex={-1} className="whitespace-nowrap text-lg font-semibold outline-none">
          Page {index + 1}
          <span className="font-normal text-muted-foreground"> of {count}</span>
        </h2>
        <p className="text-xs text-muted-foreground">
          {page.photo.found ? "Edges found. Drag a corner if it's off." : "Edges not found, so the whole photo is kept. Drag the corners onto the page's if it shows more."}
        </p>
      </div>

      <div className="contents sm:order-none sm:grid sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] sm:gap-3">
        <div ref={wrap} className="order-2 flex min-w-0 justify-center rounded-2xl border border-border bg-secondary/40 p-2 sm:order-none">
          {scale > 0 ? (
            <div data-photo className="relative touch-none select-none" style={{ width: w, height: h }} onPointerMove={moveTo} onPointerUp={drop} onPointerCancel={drop}>
              <canvas ref={photoCanvas} aria-hidden className="block !h-full !w-full rounded" />
              {!pixels && (
                <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                  {failed ? "This photo couldn't be shown." : <Loader2 className="h-4 w-4 motion-safe:animate-spin" />}
                </p>
              )}
              <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${w} ${h}`}>
                <path
                  // Dimmed outside the page: the whole photo, with the page cut out.
                  d={`M0 0H${w}V${h}H0Z M${quad.map((p) => `${p.x * w} ${p.y * h}`).join(" L")}Z`}
                  fill="rgba(15, 23, 42, 0.45)"
                  fillRule="evenodd"
                />
                <polygon points={quad.map((p) => `${p.x * w},${p.y * h}`).join(" ")} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} />
              </svg>
              {quad.map((p, i) => (
                <button
                  key={CORNER_NAMES[i]}
                  type="button"
                  aria-label={`${CORNER_NAMES[i]} corner: ${describeCorner(p)}`}
                  aria-describedby="scan-corner-hint"
                  aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown"
                  onPointerDown={grab(i)}
                  onKeyDown={(e) => key(i, e)}
                  onKeyUp={() => commit(quad)}
                  className="group absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center rounded-full focus-visible:outline-none active:cursor-grabbing"
                  style={{ left: p.x * w, top: p.y * h }}
                  data-testid={`corner-${i}`}
                >
                  <span className="h-5 w-5 rounded-full border-[3px] border-primary bg-background/90 shadow transition-transform group-focus-visible:scale-125 group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 motion-reduce:transform-none" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-1.5 h-4 w-4 motion-safe:animate-spin" /> Opening the photo…
            </div>
          )}
        </div>
        <div className="order-5 flex flex-col items-center justify-center rounded-2xl border border-border bg-secondary/40 p-2 sm:order-none">
          <canvas ref={previewCanvas} width={0} height={0} aria-label={`Page ${index + 1} as it will look`} role="img" className="block max-h-[40vh] max-w-full bg-white shadow-md sm:max-h-[520px]" data-testid="preview" />
          <p className="mt-1.5 text-xs text-muted-foreground">As it will look</p>
        </div>
      </div>
      {/* Read out with each corner; on a phone the line above says it already, and the buttons stay in view. */}
      <p id="scan-corner-hint" className="order-3 -mt-1 text-center text-xs text-muted-foreground max-sm:sr-only sm:order-none">
        <span className="hover-none:hidden">Drag the corners, or Tab to one and use the arrow keys (Shift moves further).</span>
        <span className="hidden hover-none:inline">Drag the round handles onto the page&apos;s corners.</span>
      </p>

      <div className="order-6 space-y-3 rounded-2xl border border-border bg-card p-4 sm:order-none">
        <Pills<ScanFilter> name="scan-filter" legend="Filter" value={page.filter} options={FILTERS} onChange={(f) => onChange({ filter: f }, pixels ?? undefined)} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" className="pointer-coarse:h-11" onClick={() => turn(-90)}>
            <RotateCcw /> Turn left
          </Button>
          <Button size="sm" variant="secondary" className="pointer-coarse:h-11" onClick={() => turn(90)}>
            <RotateCw /> Turn right
          </Button>
          <Button size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => setCorners(whole, "Corners at the photo's corners.")}>
            <Maximize /> Whole photo
          </Button>
          {quad !== start.current && (
            <Button size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => setCorners(page.photo.found ? page.photo.quad : insetQuad(), "Corners put back.")}>
              <Undo2 /> Reset corners
            </Button>
          )}
        </div>
      </div>

      <div className="order-4 flex flex-wrap items-center justify-between gap-2 sm:order-none" data-testid="editor-actions">
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-11" onClick={onRetake}>
            <Camera /> Retake
          </Button>
          {!fresh && (
            <Button variant="ghost" className="h-11 text-destructive" onClick={onDelete}>
              <Trash2 /> Delete page
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {fresh && canAdd ? (
            <>
              <Button variant="secondary" className="h-11" onClick={onDone} data-testid="edit-done">
                <Check /> Done
              </Button>
              <Button className="h-11" onClick={onNext} data-testid="next-page">
                <Camera /> Next page
              </Button>
            </>
          ) : (
            <Button className="h-11" onClick={onDone} data-testid="edit-done">
              {/* Changes apply as they are made: this only closes the page. */}
              <Check /> Done
            </Button>
          )}
        </div>
      </div>
    </motion.section>
  );
}
