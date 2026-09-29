"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, ArrowRight, FileText, Presentation, UploadCloud, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fileToHandoff, setHandoff } from "@/lib/local-store";
import { getTool } from "@/lib/tools";
import { EASE, SPRING } from "@/components/motion/primitives";
import { cn, formatBytes } from "@/lib/utils";

const PDF_ACTIONS = [
  "edit-pdf",
  "sign-pdf",
  "compress-pdf",
  "pdf-to-word",
  "pdf-to-pptx",
  "chat-with-pdf",
  "ocr-pdf",
  "split-pdf",
  "protect-pdf",
];
const MULTI_ACTIONS = ["merge-pdf", "compress-pdf", "pdf-to-word", "edit-pdf"];
const IMAGE_ACTIONS = ["jpg-to-pdf"];
const PPTX_ACTIONS = ["pptx-to-pdf", "edit-pptx"];

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const ACCEPT = {
  pdf: "application/pdf,image/png,image/jpeg",
  pptx: `.pptx,${PPTX_TYPE}`,
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
  error,
  autoFocus,
}: {
  mode: "pdf" | "pptx";
  files: File[];
  onFiles: (list: FileList | null) => void;
  onClear: () => void;
  dragging: boolean;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const [going, setGoing] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus && files.length === 0) chooseRef.current?.focus({ preventScroll: true });
    // Only on mount: focus follows the visitor's choice, not later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isImages = files.length > 0 && files.every((f) => f.type.startsWith("image/"));
  const actions =
    mode === "pptx" ? PPTX_ACTIONS : isImages ? IMAGE_ACTIONS : files.length > 1 ? MULTI_ACTIONS : PDF_ACTIONS;

  async function go(slug: string) {
    setGoing(slug);
    const multi = slug === "merge-pdf" || slug === "jpg-to-pdf";
    const chosen = multi ? files : files.slice(0, 1);
    // Browsers often leave `type` empty for Office files, and the handoff
    // would otherwise default it to PDF.
    const typed = chosen.map((f) => (mode === "pptx" && !f.type ? new File([f], f.name, { type: PPTX_TYPE }) : f));
    await setHandoff(await Promise.all(typed.map((f) => fileToHandoff(f))));
    router.push(`/tools/${slug}?handoff=1`);
  }

  const FileIcon = mode === "pptx" ? Presentation : FileText;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {files.length === 0 ? (
        <motion.div
          key="drop"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.3, ease: EASE }}
        >
          <motion.div
            animate={{ scale: dragging ? 1.015 : 1 }}
            transition={SPRING}
            className={cn(
              "rounded-2xl border-2 border-dashed p-4 transition-colors sm:p-5",
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
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <motion.div
                animate={dragging ? { scale: 1.15, y: -4 } : { y: [0, -5, 0] }}
                transition={dragging ? SPRING : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30"
              >
                <UploadCloud className="h-6 w-6" />
              </motion.div>
              <p className="flex-1 text-center text-lg font-semibold sm:text-left">
                {dragging ? "Release to begin" : mode === "pptx" ? "Drop a PPTX" : "Drop a PDF"}
              </p>
              <Button
                ref={chooseRef}
                size="lg"
                className="h-12 w-full px-6 shadow-lg shadow-primary/25 sm:w-auto"
                onClick={() => inputRef.current?.click()}
              >
                Choose file
              </Button>
            </div>
          </motion.div>

          <AnimatePresence>
            {error && (
              <motion.p
                role="alert"
                data-testid="tool-error"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex items-center gap-2 overflow-hidden pt-3 text-sm font-medium text-destructive"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
              </motion.p>
            )}
          </AnimatePresence>

          {mode === "pptx" && (
            <Link
              href="/tools/pdf-to-pptx"
              className="group mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
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
              actions.length === 2 ? "grid-cols-2" : actions.length === 1 ? "grid-cols-1 sm:grid-cols-2" : actions.length % 3 === 0 ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"
            )}
          >
            {actions.map((slug, i) => {
              const t = getTool(slug);
              if (!t) return null;
              return (
                <motion.button
                  key={slug}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.035 }}
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.96 }}
                  disabled={going !== null}
                  onClick={() => go(slug)}
                  className={cn(
                    "flex min-h-[5.25rem] flex-col items-center justify-center gap-1.5 rounded-2xl border border-border bg-card p-2.5 text-center text-xs font-medium leading-tight transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        </motion.div>
      )}
    </AnimatePresence>
  );
}
