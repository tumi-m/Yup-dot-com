"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getTool, TOOLS } from "@/lib/tools";
import { Reveal } from "@/components/motion/primitives";
import { cn } from "@/lib/utils";

export function ToolHeader({ slug }: { slug: string }) {
  const tool = getTool(slug)!;
  // CSS entrances: the title is the page's largest text and must paint
  // without waiting for hydration.
  return (
    <div className="text-center">
      <div className="relative mx-auto h-16 w-16 motion-safe:animate-pop">
        <span aria-hidden className={cn("absolute inset-0 rounded-2xl opacity-60 blur-xl motion-safe:animate-pulse-slow", tool.tint)} />
        <span className={cn("relative flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg", tool.tint)}>
          <tool.icon className="h-8 w-8" />
        </span>
      </div>
      <h1 className="mt-5 text-4xl font-extrabold tracking-tight motion-safe:animate-rise [animation-delay:0.05s]">
        {tool.name}
      </h1>
      <p className="mx-auto mt-3 max-w-lg text-muted-foreground motion-safe:animate-rise [animation-delay:0.1s]">
        {tool.description}
      </p>
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {related.map((t) => (
          <Reveal key={t.slug}>
            <Link
              href={`/tools/${t.slug}`}
              className="group flex min-h-14 items-center gap-3 rounded-xl border border-border bg-card p-3 transition-all hover:-translate-y-[3px] hover:border-primary/40 hover:shadow-md"
            >
              <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", t.tint)}>
                <t.icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</span>
              <ArrowRight className="h-4 w-4 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
            </Link>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
