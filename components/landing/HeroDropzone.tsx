"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, FileText, Presentation, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropTile } from "@/components/ui/dropzone";
import { fileToHandoff, tryHandoff } from "@/lib/local-store";
import { getTool } from "@/lib/tools";
import { ENTER_T, EXIT, InlineError, RESIZE_T, staggerDelay } from "@/components/motion/primitives";
import { useFocusNext } from "@/components/motion/focus";
import { cn, formatBytes } from "@/lib/utils";
import { heroActions, MIXED_ACTIONS, MULTI_ACTIONS, TAKES_ALL } from "./hero-actions";

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const ACCEPT = {
  pdf: "application/pdf,image/png,image/jpeg",
  pptx: `.pptx,${PPTX_TYPE}`,
};

/**
 * Each branch keeps one height whether it shows the drop zone or the tools
 * for a chosen file: the tallest of the two (for PDFs, the nine-tool grid).
 * A file picked in the system dialog or dropped isn't "recent input", so
 * growing then would shift the page under the visitor. Wherever a file can
 * be dropped (a mouse, or a wide screen) the room is held from the start; on
 * a phone, where the only way in is the Choose file button, it is taken at
 * that tap (`armed`), so the drop zone isn't padded with empty space.
 */
const RESERVE = {
  pdf: { always: "sm:min-h-[332px] max-sm:pointer-fine:min-h-[342px]", armed: "min-h-[342px] sm:min-h-[332px]" },
  pptx: { always: "sm:min-h-[160px] max-sm:pointer-fine:min-h-[244px]", armed: "min-h-[244px] sm:min-h-[160px]" },
};

/**
 * Drop a file, pick a spell. The file is handed to the chosen tool without a
 * second upload. The parent owns the files so a drop anywhere on the hero
 * panel lands here.
 */
export function HeroDropzone({
  mode,
  files,
  onFiles,
  onClear,
  dragging,
  drops = 0,
  error,
  autoFocus,
}: {
  mode: "pdf" | "pptx";
  files: File[];
  onFiles: (list: FileList | null) => void;
  onClear: () => void;
  dragging: boolean;
  /** Counts drops, so the tile can swallow each one. */
  drops?: number;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const [going, setGoing] = useState<string | null>(null);
  /** The tool the files couldn't be passed to. */
  const [failed, setFailed] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The control focus goes to when the view it was in swaps out. */
  const { next: focusNext, focusRef } = useFocusNext<"tools" | "choose" | "failed">();
  const hasFiles = files.length > 0;

  useEffect(() => {
    if (autoFocus && files.length === 0) chooseRef.current?.focus({ preventScroll: true });
    // Only on mount: focus follows the visitor's choice, not later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Choosing or clearing files swaps the view: keep focus in the panel if it was there.
  const hadFiles = useRef(hasFiles);
  useEffect(() => {
    if (hadFiles.current === hasFiles) return;
    hadFiles.current = hasFiles;
    setFailed(null);
    if (boxRef.current?.contains(document.activeElement)) focusNext.current = hasFiles ? "tools" : "choose";
  }, [hasFiles, focusNext]);

  const actions = heroActions(mode, files);

  async function go(slug: string) {
    // The buttons are disabled while the files are stored, which drops focus.
    const hadFocus = !!boxRef.current?.contains(document.activeElement);
    setGoing(slug);
    setFailed(null);
    const chosen = TAKES_ALL.includes(slug) ? files : files.slice(0, 1);
    // Browsers often leave `type` empty for Office files, and the handoff
    // would otherwise default it to PDF.
    const typed = chosen.map((f) => (mode === "pptx" && !f.type ? new File([f], f.name, { type: PPTX_TYPE }) : f));
    if (await tryHandoff(typed.map((f) => fileToHandoff(f)))) {
      router.push(`/tools/${slug}?handoff=1`);
      return;
    }
    if (hadFocus || document.activeElement === document.body) focusNext.current = "failed";
    setGoing(null);
    setFailed(slug);
  }

  const FileIcon = mode === "pptx" ? Presentation : FileText;
  const failedTool = failed ? getTool(failed) : undefined;

  return (
    // A layout node, so taking the room at the tap resizes the panel smoothly.
    <motion.div ref={boxRef} layout="position" transition={{ layout: RESIZE_T }} className={cn("flex flex-col", RESERVE[mode].always, armed && RESERVE[mode].armed)}>
    <AnimatePresence mode="wait" initial={false}>
      {files.length === 0 ? (
        <motion.div
          key="drop"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={EXIT}
          transition={ENTER_T}
          className="flex flex-1 flex-col"
        >
          <div
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-4 transition-[border-color,background-color] duration-150 sm:p-5",
              mode === "pptx" && "sm:flex-row",
              dragging ? "border-primary bg-primary/5" : "border-primary/30 hover:border-primary/60"
            )}
          >
            <input
              ref={inputRef}
              type="file"
              multiple={mode === "pdf"}
              accept={ACCEPT[mode]}
              className="hidden"
              aria-label={mode === "pptx" ? "Choose a PPTX file" : "Choose files"}
              onChange={(e) => {
                onFiles(e.target.files);
                e.target.value = "";
              }}
            />
            {/* Same treatment as the shared drop zone: bob at rest, lift on drag, swallow the drop. */}
            <DropTile
              dragging={dragging}
              drops={drops}
              className={cn(
                "bg-primary text-primary-foreground shadow-lg shadow-primary/30",
                mode === "pptx" && "h-12 w-12 [&_svg]:h-6 [&_svg]:w-6"
              )}
            />
            <p className={cn("text-center text-lg font-semibold", mode === "pptx" && "sm:flex-1 sm:text-left")}>
              {dragging ? "Release" : mode === "pptx" ? "Drop a PPTX" : "Drop a PDF"}
            </p>
            <Button
              ref={(el) => {
                chooseRef.current = el;
                focusRef("choose")(el);
              }}
              size="lg"
              className={cn("h-12 w-full px-6 shadow-lg shadow-primary/25 sm:w-auto", dragging && "invisible")}
              onClick={() => {
                setArmed(true);
                inputRef.current?.click();
              }}
            >
              Choose file
            </Button>
          </div>

          <AnimatePresence>
            {error && <InlineError key="error" compact message={error} className="pt-3 text-sm" />}
          </AnimatePresence>

          {mode === "pptx" && (
            <Link
              href="/tools/pdf-to-pptx"
              className="group mt-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              PDF to PPTX
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}
        </motion.div>
      ) : (
        <motion.div
          key="actions"
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={EXIT}
          transition={ENTER_T}
        >
          <div className="flex items-center gap-3 rounded-xl bg-secondary/60 py-1 pl-3 pr-1">
            <FileIcon className="h-5 w-5 shrink-0 text-primary" />
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">
              {files.length === 1 ? files[0].name : `${files.length} files`}
              <span className="ml-2 font-normal text-muted-foreground">
                {formatBytes(files.reduce((n, f) => n + f.size, 0))}
              </span>
            </p>
            <button
              // With no tool to offer, focus waits here.
              ref={actions === MIXED_ACTIONS ? focusRef("tools") : undefined}
              onClick={onClear}
              aria-label="Choose different files"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div
            role="group"
            aria-label="Choose a tool"
            className={cn(
              "mt-3 grid gap-2",
              actions.length === 0 && "hidden",
              actions.length === 2 ? "grid-cols-2" : actions.length === 1 ? "grid-cols-1 sm:grid-cols-2" : actions.length % 3 === 0 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"
            )}
          >
            {actions.map((slug, i) => {
              const t = getTool(slug);
              if (!t) return null;
              return (
                <motion.button
                  key={slug}
                  ref={i === 0 ? focusRef("tools") : undefined}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...ENTER_T, delay: staggerDelay(i) }}
                  whileTap={{ scale: 0.97 }}
                  disabled={going !== null}
                  onClick={() => go(slug)}
                  className={cn(
                    "flex min-h-[5.25rem] flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-card p-2.5 text-center text-xs font-medium leading-tight transition-colors duration-200 hover:border-primary/50 hover:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    mode === "pptx" && "min-h-[6rem] text-sm font-semibold",
                    going === slug && "border-primary"
                  )}
                >
                  <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl", t.tint)}>
                    <t.icon className="h-4 w-4" />
                  </span>
                  {t.name}
                </motion.button>
              );
            })}
          </div>
          {actions === MULTI_ACTIONS && (
            <p className="mt-3 text-center text-xs text-muted-foreground">Other tools take one PDF at a time.</p>
          )}
          {actions === MIXED_ACTIONS && (
            <p role="status" className="mt-3 text-center text-sm text-muted-foreground">
              PDFs and images go to different tools. Pick one kind.
            </p>
          )}
          <AnimatePresence>
            {failedTool && (
              <InlineError
                key="handoff"
                compact
                className="pt-3 text-sm"
                message={
                  <>
                    Couldn&apos;t pass the file on.{" "}
                    <Link ref={focusRef("failed")} href={`/tools/${failedTool.slug}`} className="tap whitespace-nowrap font-semibold underline underline-offset-2">
                      Open {failedTool.name}
                    </Link>
                  </>
                }
              />
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
    </motion.div>
  );
}
