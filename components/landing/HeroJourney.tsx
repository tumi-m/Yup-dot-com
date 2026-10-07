"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  ArrowLeft,
  ClipboardPaste,
  Clapperboard,
  FileDown,
  FileText,
  Film,
  GalleryHorizontalEnd,
  Link2,
  Music2,
  ListVideo,
  PencilRuler,
  Presentation,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import { DUR, EASE, EASE_IN, EASE_OUT, SPRING_POP, STAGGER } from "@/components/motion/primitives";
import {
  choiceForFiles,
  choiceFromHash,
  fileKind,
  JOURNEY_CHOICES,
  mediaActions,
  slidesActions,
  type JourneyAction,
  type JourneyChoice,
} from "@/lib/journey";
import { parseMediaUrl, parsePlaylistUrl, PLATFORM_LABEL } from "@/lib/media";
import { cn } from "@/lib/utils";
import { HeroDropzone } from "./HeroDropzone";

const CHOICES: Record<JourneyChoice, { label: string; icon: LucideIcon; tint: string }> = {
  pdf: { label: "PDF", icon: FileText, tint: "bg-violet-100 text-violet-700" },
  pptx: { label: "PowerPoint", icon: Presentation, tint: "bg-orange-100 text-orange-700" },
  slides: { label: "Google Slides", icon: GalleryHorizontalEnd, tint: "bg-amber-100 text-amber-800" },
  media: { label: "Video & audio", icon: Clapperboard, tint: "bg-rose-100 text-rose-700" },
};

const ACTION_ICONS: Record<string, LucideIcon> = {
  PDF: FileDown,
  PPTX: Presentation,
  Edit: PencilRuler,
  MP4: Film,
  MP3: Music2,
  Playlist: ListVideo,
};

function setHash(choice: JourneyChoice | null) {
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", choice ? `#${choice}` : pathname + search);
}

/**
 * The homepage's first step: ask what the visitor is working on, then morph
 * into that branch. `#pdf`, `#pptx`, `#slides` and `#media` skip the question.
 */
export function HeroJourney() {
  const reduce = useReducedMotion();
  const [choice, setChoice] = useState<JourneyChoice | null>(null);
  // True once the visitor picks something, so branches take focus; a deep
  // link on page load must not steal focus (or pop a phone keyboard).
  const [interacted, setInteracted] = useState(false);
  const [pdfFiles, setPdfFiles] = useState<File[]>([]);
  const [pptxFile, setPptxFile] = useState<File | null>(null);
  const [pptxError, setPptxError] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const tiles = useRef<Partial<Record<JourneyChoice, HTMLButtonElement | null>>>({});
  /** The tile to focus when the question comes back. */
  const returnTo = useRef<JourneyChoice | null>(null);

  // Deep links, both on load and from in-page anchors.
  useEffect(() => {
    const sync = () => {
      const c = choiceFromHash(window.location.hash);
      if (c) setChoice(c);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const choose = useCallback((c: JourneyChoice) => {
    setInteracted(true);
    setDropError(null);
    setChoice(c);
    setHash(c);
  }, []);

  function back() {
    returnTo.current = choice;
    setDropError(null);
    setChoice(null);
    setHash(null);
  }

  /** Every drop and file pick lands here and opens the matching branch. */
  function receive(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    const target = choiceForFiles(files);
    if (!target) {
      setPptxError(null);
      setDropError("Drop a PDF, image or PPTX.");
      return;
    }
    setDropError(null);
    if (target === "pdf") {
      setPdfFiles(files.filter((f) => ["pdf", "image"].includes(fileKind(f))));
    } else {
      const pptx = files.find((f) => fileKind(f) === "pptx");
      setPptxFile(pptx ?? null);
      setPptxError(pptx ? null : "Save it as .pptx first.");
    }
    if (target !== choice) choose(target);
  }

  // Animate the panel's height as its content changes.
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const active = choice ? CHOICES[choice] : null;
  const fileBranchEmpty =
    (choice === "pdf" && pdfFiles.length === 0) || (choice === "pptx" && !pptxFile);

  return (
    <div
      id="start"
      className="relative scroll-mt-24"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        receive(e.dataTransfer.files);
      }}
      data-testid="journey"
      data-choice={choice ?? ""}
    >
      <motion.div
        animate={{ height }}
        transition={reduce ? { duration: 0 } : { duration: DUR.base, ease: EASE_OUT }}
        className="relative overflow-hidden rounded-3xl border border-primary/20 bg-background/90 text-left shadow-2xl shadow-primary/10"
      >
        <div ref={inner} className="p-3 sm:p-4">
          {/* "wait": the old state fades out before the new one enters, so the
              two never overlap. */}
          <AnimatePresence mode="wait" initial={false}>
            {choice === null || !active ? (
              <motion.div
                key="question"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: DUR.tap, ease: EASE_IN } }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
              >
                <p id="journey-question" className="px-1 pb-3 pt-1 text-sm font-semibold">
                  What are you working on?
                </p>
                <div
                  role="group"
                  aria-labelledby="journey-question"
                  className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                  onKeyDown={(e) => {
                    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
                    if (!keys.includes(e.key)) return;
                    const list = JOURNEY_CHOICES.map((c) => tiles.current[c]).filter(Boolean) as HTMLButtonElement[];
                    const i = list.indexOf(document.activeElement as HTMLButtonElement);
                    if (i < 0) return;
                    e.preventDefault();
                    const n = list.length;
                    const next =
                      e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
                    list[next].focus();
                  }}
                >
                  {JOURNEY_CHOICES.map((c, i) => {
                    const { label, icon: Icon, tint } = CHOICES[c];
                    return (
                      <motion.button
                        key={c}
                        ref={(el) => {
                          tiles.current[c] = el;
                          // Coming back to the question puts focus on the tile that
                          // was chosen, once it is back on the page (after the exit).
                          if (el && returnTo.current === c) {
                            returnTo.current = null;
                            el.focus({ preventScroll: true });
                          }
                        }}
                        type="button"
                        data-choice={c}
                        onClick={() => choose(c)}
                        // Server-rendered tiles paint at once; they only rise in
                        // when the visitor comes back to the question.
                        initial={interacted ? { opacity: 0, y: 8 } : false}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: DUR.base, ease: EASE_OUT, delay: STAGGER * i }}
                        whileHover={{ y: -3 }}
                        whileTap={{ scale: 0.97 }}
                        className="group flex min-h-[6.5rem] flex-col items-center justify-center gap-2.5 rounded-2xl border border-border bg-card/90 px-2 py-4 text-sm font-semibold shadow-sm transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      >
                        <span className={cn("flex h-11 w-11 items-center justify-center rounded-xl", tint)}>
                          <Icon className="h-5 w-5 transition-transform duration-300 group-hover:scale-110" />
                        </span>
                        {label}
                      </motion.button>
                    );
                  })}
                </div>
                <AnimatePresence initial={false}>
                  {dropError ? (
                    <motion.p
                      key="err"
                      role="alert"
                      data-testid="tool-error"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center justify-center gap-1.5 pt-3 text-xs font-medium text-destructive"
                    >
                      <AlertTriangle className="h-3.5 w-3.5" /> {dropError}
                    </motion.p>
                  ) : (
                    // Nothing to drop on a touch screen.
                    <p className="flex items-center justify-center gap-1.5 pt-3 text-xs text-muted-foreground pointer-coarse:hidden">
                      <UploadCloud className="h-3.5 w-3.5" /> or drop a file
                    </p>
                  )}
                </AnimatePresence>
              </motion.div>
            ) : (
              <motion.div
                key={choice}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: DUR.tap, ease: EASE_IN } }}
                transition={{ duration: 0.28, ease: EASE_OUT }}
              >
                <div className="flex items-center gap-3 pb-3">
                  <motion.span
                    initial={{ scale: 0.6, rotate: -12 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={SPRING_POP}
                    className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", active.tint)}
                  >
                    <active.icon className="h-5 w-5" />
                  </motion.span>
                  <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{active.label}</h2>
                  <button
                    type="button"
                    onClick={back}
                    className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ArrowLeft className="h-4 w-4" /> Change
                  </button>
                </div>

                {choice === "pdf" && (
                  <HeroDropzone
                    mode="pdf"
                    files={pdfFiles}
                    onFiles={receive}
                    onClear={() => setPdfFiles([])}
                    dragging={dragging}
                    autoFocus={interacted}
                  />
                )}
                {choice === "pptx" && (
                  <HeroDropzone
                    mode="pptx"
                    files={pptxFile ? [pptxFile] : []}
                    onFiles={receive}
                    onClear={() => setPptxFile(null)}
                    dragging={dragging}
                    error={pptxError}
                    autoFocus={interacted}
                  />
                )}
                {choice === "slides" && (
                  <LinkBranch
                    id="journey-slides-url"
                    label="Google Slides link"
                    placeholder="docs.google.com/…"
                    hint="Paste a Google Slides link."
                    actionsFor={slidesActions}
                    autoFocus={interacted}
                  />
                )}
                {choice === "media" && (
                  <LinkBranch
                    id="journey-media-url"
                    label="YouTube or X link"
                    placeholder="youtu.be/… or x.com/…"
                    hint="Paste a YouTube or X video link."
                    actionsFor={mediaActions}
                    tag={(url) => {
                      if (parsePlaylistUrl(url)) return "YouTube playlist";
                      const p = parseMediaUrl(url);
                      return p ? PLATFORM_LABEL[p.platform] : null;
                    }}
                    autoFocus={interacted}
                  />
                )}
                {dropError && (
                  <p
                    role="alert"
                    data-testid="tool-error"
                    className="flex items-center gap-1.5 px-1 pt-3 text-xs font-medium text-destructive"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {dropError}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Drop overlay for states without their own dropzone. */}
        <AnimatePresence>
          {dragging && !fileBranchEmpty && (
            <motion.div
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="pointer-events-none absolute inset-1.5 flex items-center justify-center gap-2 rounded-[1.25rem] border-2 border-dashed border-primary bg-background/95 text-base font-semibold text-primary"
            >
              <UploadCloud className="h-5 w-5" /> Release
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

function LinkBranch({
  id,
  label,
  placeholder,
  hint,
  actionsFor,
  tag,
  autoFocus,
}: {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  actionsFor: (url: string) => JourneyAction[];
  tag?: (url: string) => string | null;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [pasteError, setPasteError] = useState(false);
  const actions = url.trim() ? actionsFor(url) : [];
  const invalid = url.trim() !== "" && actions.length === 0;
  const platform = actions.length && tag ? tag(url) : null;

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function paste() {
    setPasteError(false);
    try {
      const text = await navigator.clipboard.readText();
      if (text) setUrl(text.trim());
    } catch {
      setPasteError(true);
      inputRef.current?.focus();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (actions[0]) router.push(actions[0].href);
      }}
    >
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="relative">
        <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          ref={inputRef}
          id={id}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setPasteError(false);
          }}
          placeholder={placeholder}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-status`}
          className="h-14 w-full rounded-2xl border border-input bg-background pl-10 pr-24 text-sm shadow-sm outline-none transition-shadow placeholder:text-muted-foreground/80 focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={paste}
          className="absolute right-1.5 top-1/2 inline-flex h-11 -translate-y-1/2 items-center gap-1.5 rounded-xl bg-secondary px-3 text-sm font-medium text-secondary-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ClipboardPaste className="h-4 w-4" /> Paste
        </button>
      </div>

      <div id={`${id}-status`} aria-live="polite" className="min-h-0">
        {invalid && <p className="px-1 pt-2 text-xs font-medium text-amber-700">{hint}</p>}
        {pasteError && <p className="px-1 pt-2 text-xs font-medium text-amber-700">Clipboard blocked. Paste with Ctrl+V.</p>}
        {platform && <span className="sr-only">{platform} link</span>}
      </div>

      <AnimatePresence initial={false}>
        {actions.length > 0 && (
          <motion.div
            key="actions"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="pt-3"
          >
            {platform && (
              <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground" aria-hidden>
                {platform}
              </p>
            )}
            <div className={cn("grid gap-2", actions.length === 3 ? "grid-cols-3" : actions.length === 1 ? "grid-cols-1" : "grid-cols-2")}>
              {actions.map((a, i) => {
                const Icon = ACTION_ICONS[a.label] ?? FileDown;
                return (
                  <motion.div
                    key={a.href}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05, duration: 0.3, ease: EASE }}
                    whileHover={{ y: -3 }}
                    whileTap={{ scale: 0.97 }}
                    tabIndex={-1}
                  >
                    <Link
                      href={a.href}
                      className={cn(
                        "flex h-14 items-center justify-center gap-2 rounded-2xl text-sm font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                        i === 0
                          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90"
                          : "border border-border bg-card hover:border-primary/50"
                      )}
                    >
                      <Icon className="h-4 w-4" /> {a.label}
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}
