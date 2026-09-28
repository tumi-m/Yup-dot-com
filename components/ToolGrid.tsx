"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Search, X } from "lucide-react";
import { TOOLS, CATEGORY_LABELS, type ToolCategory, type ToolMeta } from "@/lib/tools";
import { EASE, SpotlightCard } from "@/components/motion/primitives";
import { cn } from "@/lib/utils";

const ORDER: ToolCategory[] = [
  "organize",
  "optimize",
  "convert",
  "extract",
  "security",
  "edit",
  "media",
];

function ToolCard({ tool, index }: { tool: ToolMeta; index: number }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
      transition={{ duration: 0.45, ease: EASE, delay: Math.min(index, 12) * 0.035 }}
    >
      <Link href={`/tools/${tool.slug}`} className="block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <SpotlightCard className="h-full rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/40">
          <div className="relative flex items-start gap-4">
            <motion.div
              className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", tool.tint)}
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.1 }}
              transition={{ duration: 0.45 }}
            >
              <tool.icon className="h-5 w-5" />
            </motion.div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-semibold transition-colors group-hover:text-primary">
                {tool.name}
                {tool.badge && (
                  <span className="rounded-full bg-gradient-to-r from-primary to-fuchsia-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                    {tool.badge}
                  </span>
                )}
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{tool.description}</p>
            </div>
          </div>
        </SpotlightCard>
      </Link>
    </motion.div>
  );
}

/**
 * Tool catalogue. With `filterable`, adds instant search and category pills —
 * the catalogue is large enough now that scanning it by eye is slow.
 */
export function ToolGrid({ filterable = false }: { filterable?: boolean }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ToolCategory | "all">("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOLS.filter(
      (t) =>
        (category === "all" || t.category === category) &&
        (!q || `${t.name} ${t.description} ${CATEGORY_LABELS[t.category]}`.toLowerCase().includes(q))
    );
  }, [query, category]);

  if (!filterable) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {TOOLS.map((tool, i) => (
          <ToolCard key={tool.slug} tool={tool} index={i} />
        ))}
      </div>
    );
  }

  const pills: (ToolCategory | "all")[] = ["all", ...ORDER];

  return (
    <div>
      <div className="mx-auto mb-8 flex max-w-3xl flex-col items-center gap-4">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools"
            aria-label="Search tools"
            className="h-12 w-full rounded-full border border-input bg-background pl-10 pr-10 text-sm shadow-sm outline-none transition-shadow focus:ring-2 focus:ring-ring"
          />
          <AnimatePresence>
            {query && (
              <motion.button
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-accent"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        <LayoutGroup>
          <div role="tablist" aria-label="Tool categories" className="flex flex-wrap justify-center gap-1.5">
            {pills.map((p) => {
              const active = category === p;
              return (
                <button
                  key={p}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setCategory(p)}
                  className={cn(
                    "relative rounded-full px-4 py-3 text-sm font-medium transition-colors sm:py-1.5",
                    active ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="category-pill"
                      className="absolute inset-0 rounded-full bg-primary shadow-md shadow-primary/30"
                      transition={{ type: "spring", stiffness: 420, damping: 32 }}
                    />
                  )}
                  <span className="relative">{p === "all" ? "All" : CATEGORY_LABELS[p]}</span>
                </button>
              );
            })}
          </div>
        </LayoutGroup>
      </div>

      <motion.div layout className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <AnimatePresence mode="popLayout">
          {filtered.map((tool, i) => (
            <ToolCard key={tool.slug} tool={tool} index={i} />
          ))}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>
        {filtered.length === 0 && (
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="py-16 text-center text-muted-foreground"
          >
            No spell matches “{query}”. Try a different word.
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
