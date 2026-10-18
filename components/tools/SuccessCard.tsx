"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Download, File as FileIcon } from "lucide-react";
import {
  EXIT_T,
  InlineError,
  NOTICE_T,
  ENTER_T,
  SUCCESS,
  SUCCESS_CARD_T,
  SuccessBadge,
  staggerDelay,
} from "@/components/motion/primitives";
import { getTool, type ToolMeta } from "@/lib/tools";
import { cn, formatBytes } from "@/lib/utils";

/** A result row in a multi-file success card. */
export interface SuccessFile {
  name: string;
  size: number;
  onDownload: () => void;
}

const at = (delay: number) => ({ ...ENTER_T, delay });

/**
 * The finished-task card shared by every file tool. One choreography, timed
 * from the card's mount: badge, title, stats, then the primary action (ready
 * by 0.45s), then next steps, and only later the quiet upsell. The caller
 * settles the page (settleSlot) as the work view leaves, so the card enters
 * already in view and the page never moves under it.
 */
export function SuccessCard({
  title = "Spell complete",
  titleRef,
  stats,
  files,
  actions,
  next,
  upsell,
  className,
}: {
  title?: string;
  /** Receives the heading, e.g. to move focus there. */
  titleRef?: React.Ref<HTMLHeadingElement>;
  /** Chips under the title. */
  stats?: React.ReactNode;
  files?: SuccessFile[];
  /** Primary and secondary buttons. */
  actions: React.ReactNode;
  /** `failed`: the tool the file couldn't be passed to, if a pick failed. */
  next?: { slugs: string[]; onPick: (slug: string) => void; failed?: string | null };
  upsell?: React.ReactNode;
  className?: string;
}) {
  const tools = (next?.slugs ?? []).map((slug) => getTool(slug)).filter((t): t is ToolMeta => !!t);
  const failed = next?.failed ? getTool(next.failed) : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: EXIT_T }}
      transition={SUCCESS_CARD_T}
      className={cn(
        "relative flex flex-col justify-center overflow-hidden rounded-3xl border border-border bg-card p-6 text-center shadow-xl shadow-primary/5 sm:p-10",
        className
      )}
    >
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-emerald-400/15 to-transparent" />
      <SuccessBadge />

      <motion.h2
        ref={titleRef}
        tabIndex={-1}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={at(SUCCESS.title)}
        className="relative mx-auto mt-5 rounded-lg px-2 text-2xl font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {title}
      </motion.h2>

      {stats && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...NOTICE_T, delay: SUCCESS.stats }}
          className="relative mt-3 flex flex-wrap items-center justify-center gap-2 text-xs"
        >
          {stats}
        </motion.div>
      )}

      {files && files.length > 1 && (
        <ul className="relative mx-auto mt-6 max-h-56 w-full max-w-md space-y-1.5 overflow-y-auto text-left">
          {files.map((f, i) => (
            <motion.li
              key={f.name + i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...NOTICE_T, delay: SUCCESS.list + staggerDelay(i) }}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <FileIcon className="h-4 w-4 shrink-0 text-primary" />
              {/* Truncate in the middle: the end ("…-page-12.jpg") tells files apart. */}
              <span className="flex min-w-0 flex-1" title={f.name}>
                <span className="truncate">{f.name.slice(0, -12)}</span>
                <span className="shrink-0">{f.name.slice(-12)}</span>
              </span>
              <span className="text-xs text-muted-foreground">{formatBytes(f.size)}</span>
              <button
                onClick={f.onDownload}
                className="-my-2 -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[color,background-color,transform] duration-200 hover:bg-accent hover:text-foreground hover:duration-100 active:scale-[0.97] motion-reduce:active:scale-100"
                aria-label={`Download ${f.name}`}
              >
                <Download className="h-4 w-4" />
              </button>
            </motion.li>
          ))}
        </ul>
      )}

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={at(SUCCESS.actions)}
        className="relative mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row"
      >
        {actions}
      </motion.div>

      {tools.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={at(SUCCESS.next)}
          className="relative mt-8"
        >
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Next</p>
          <div className="flex flex-wrap justify-center gap-2">
            {tools.map((t) => (
              <motion.button
                key={t.slug}
                whileTap={{ scale: 0.97 }}
                onClick={() => next?.onPick(t.slug)}
                className="flex min-h-11 items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-sm font-medium transition-colors duration-200 hover:border-primary/50 hover:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className={cn("flex h-6 w-6 items-center justify-center rounded-full", t.tint)}>
                  <t.icon className="h-3.5 w-3.5" />
                </span>
                {t.name}
              </motion.button>
            ))}
          </div>
          <AnimatePresence>
            {failed && (
              <InlineError
                key="handoff"
                compact
                className="mt-3 justify-center"
                message={
                  <>
                    Couldn&apos;t pass the file on. Download it first.{" "}
                    <Link href={`/tools/${failed.slug}`} className="tap whitespace-nowrap font-semibold underline underline-offset-2">
                      Open {failed.name}
                    </Link>
                  </>
                }
              />
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {upsell}
    </motion.div>
  );
}
