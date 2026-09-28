"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { getTool, TOOLS } from "@/lib/tools";
import { EASE, Stagger, StaggerItem } from "@/components/motion/primitives";
import { cn } from "@/lib/utils";

export function ToolHeader({ slug }: { slug: string }) {
  const tool = getTool(slug)!;
  return (
    <div className="text-center">
      <motion.div
        initial={{ scale: 0.4, rotate: -25, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 300, damping: 16 }}
        className="relative mx-auto h-16 w-16"
      >
        <span aria-hidden className={cn("absolute inset-0 rounded-2xl opacity-60 blur-xl motion-safe:animate-pulse-slow", tool.tint)} />
        <span className={cn("relative flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg", tool.tint)}>
          <tool.icon className="h-8 w-8" />
        </span>
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
        className="mt-5 text-4xl font-extrabold tracking-tight"
      >
        {tool.name}
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.2 }}
        className="mx-auto mt-3 max-w-lg text-muted-foreground"
      >
        {tool.description}
      </motion.p>
    </div>
  );
}

/** Same-category tools first, then the most-used ones, excluding this tool. */
export function RelatedTools({ slug }: { slug: string }) {
  const tool = getTool(slug)!;
  const popular = ["merge-pdf", "compress-pdf", "pdf-to-word", "edit-pdf", "ocr-pdf", "sign-pdf"];
  const related = [
    ...TOOLS.filter((t) => t.category === tool.category && t.slug !== slug),
    ...popular.map((s) => getTool(s)!).filter((t) => t && t.slug !== slug && t.category !== tool.category),
  ].slice(0, 4);

  return (
    <section className="mt-20">
      <h2 className="mb-5 text-center text-lg font-semibold">More tools</h2>
      <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {related.map((t) => (
          <StaggerItem key={t.slug}>
            <Link
              href={`/tools/${t.slug}`}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", t.tint)}>
                <t.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
              <ArrowRight className="h-4 w-4 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
            </Link>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}
