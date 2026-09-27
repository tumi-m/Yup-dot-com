"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { FileText, ShieldCheck, UploadCloud, X } from "lucide-react";
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
  "chat-with-pdf",
  "ocr-pdf",
  "split-pdf",
  "protect-pdf",
];
const MULTI_ACTIONS = ["merge-pdf", "compress-pdf", "pdf-to-word", "edit-pdf"];
const IMAGE_ACTIONS = ["jpg-to-pdf"];

/**
 * The homepage's primary action: drop a file, pick a spell. No account, no
 * detour through a tool list — the fastest path to value, and the file is
 * handed to the chosen tool without a second upload.
 */
export function HeroDropzone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [going, setGoing] = useState<string | null>(null);

  const isImages = files.length > 0 && files.every((f) => f.type.startsWith("image/"));
  const actions = isImages ? IMAGE_ACTIONS : files.length > 1 ? MULTI_ACTIONS : PDF_ACTIONS;

  function accept(list: FileList | null) {
    if (!list?.length) return;
    const ok = Array.from(list).filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf") || /image\/(png|jpeg)/.test(f.type)
    );
    if (ok.length) setFiles(ok);
  }

  async function go(slug: string) {
    setGoing(slug);
    const multi = getTool(slug)?.slug === "merge-pdf" || slug === "jpg-to-pdf";
    const chosen = multi ? files : files.slice(0, 1);
    await setHandoff(await Promise.all(chosen.map((f) => fileToHandoff(f))));
    router.push(`/tools/${slug}?handoff=1`);
  }

  return (
    <div id="start" className="scroll-mt-24">
      <AnimatePresence mode="wait" initial={false}>
        {files.length === 0 ? (
          <motion.div
            key="drop"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0, scale: dragging ? 1.02 : 1 }}
            exit={{ opacity: 0, y: -8 }}
            transition={SPRING}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              accept(e.dataTransfer.files);
            }}
            className={cn(
              "relative overflow-hidden rounded-3xl border-2 border-dashed bg-background/80 p-6 shadow-xl shadow-primary/10 backdrop-blur-xl transition-colors",
              dragging ? "border-primary bg-primary/5" : "border-primary/30 hover:border-primary/70"
            )}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg"
              className="hidden"
              aria-label="Choose files"
              onChange={(e) => {
                accept(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <motion.div
                animate={dragging ? { scale: 1.15, y: -4 } : { y: [0, -5, 0] }}
                transition={dragging ? SPRING : { duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30"
              >
                <UploadCloud className="h-7 w-7" />
              </motion.div>
              <div className="flex-1 text-center sm:text-left">
                <p className="text-lg font-semibold">{dragging ? "Release to begin" : "Drop a PDF to get started"}</p>
                <p className="text-sm text-muted-foreground">Edit, sign, convert, or compress — free, no sign-up</p>
              </div>
              <Button size="lg" className="h-12 px-6 shadow-lg shadow-primary/25" onClick={() => inputRef.current?.click()}>
                Choose file
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="actions"
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="rounded-3xl border border-border bg-background/90 p-5 text-left shadow-xl shadow-primary/10 backdrop-blur-xl"
          >
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                {files.length === 1 ? files[0].name : `${files.length} files`}
                <span className="ml-2 font-normal text-muted-foreground">
                  {formatBytes(files.reduce((n, f) => n + f.size, 0))}
                </span>
              </p>
              <button onClick={() => setFiles([])} aria-label="Choose different files" className="rounded p-1 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 mt-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              What would you like to do?
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {actions.map((slug, i) => {
                const t = getTool(slug);
                if (!t) return null;
                return (
                  <motion.button
                    key={slug}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    whileHover={{ y: -3 }}
                    whileTap={{ scale: 0.96 }}
                    disabled={going !== null}
                    onClick={() => go(slug)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-2xl border border-border bg-card p-3 text-xs font-medium transition-colors hover:border-primary/50",
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
      <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground lg:justify-start">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Files are processed on your device. No account, no watermark.
      </p>
    </div>
  );
}
