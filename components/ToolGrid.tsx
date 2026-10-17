"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Search, X } from "lucide-react";
import { TOOLS, type ToolMeta } from "@/lib/tools";
import {
  DUR,
  ENTER_T,
  EXIT_T,
  POP_IN,
  Reveal,
  SPRING_LAYOUT,
  SpotlightCard,
  staggerDelay,
} from "@/components/motion/primitives";
import { filterTools, parsePill, pillLabel, rovingIndex, TOOL_PILLS, type ToolPill } from "@/components/tool-filter";
import { cn } from "@/lib/utils";

/** Icon and name only below sm, so the phone grid is two compact columns. */
function ToolCard({ tool }: { tool: ToolMeta }) {
  return (
    <Link
      href={`/tools/${tool.slug}`}
      className="group/link block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <SpotlightCard className="h-full rounded-2xl border border-border bg-card p-4 hover:border-primary/40 sm:p-5">
        <div className="relative flex flex-col items-start gap-3 sm:flex-row sm:gap-4">
          <div
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 ease-out group-hover:-rotate-6 group-hover:scale-110 group-hover:duration-150 motion-reduce:transform-none",
              tool.tint
            )}
          >
            <tool.icon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold leading-snug transition-colors duration-200 group-hover:text-primary group-hover:duration-100 sm:text-base">
              {tool.name}
              {tool.badge && (
                <span className="rounded-full bg-gradient-to-r from-primary to-fuchsia-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                  {tool.badge}
                </span>
              )}
            </p>
            <p className="mt-1 hidden text-sm text-muted-foreground sm:line-clamp-2">{tool.description}</p>
          </div>
        </div>
      </SpotlightCard>
    </Link>
  );
}

const GRID = "grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4";

/**
 * Tool catalogue. With `filterable`, adds instant search and category pills.
 * Filtering keeps one grid: cards that leave fade out together, the ones that
 * stay glide to their new places, and new ones fade in, so the page never
 * empties and nothing below slides under the cards that are leaving.
 */
export function ToolGrid({ filterable = false }: { filterable?: boolean }) {
  if (!filterable) {
    return (
      <div className={GRID}>
        {TOOLS.map((tool) => (
          <Reveal key={tool.slug}>
            <ToolCard tool={tool} />
          </Reveal>
        ))}
      </div>
    );
  }
  return <FilterableGrid />;
}

function FilterableGrid() {
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const [pill, setPill] = useState<ToolPill>("all");
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // `?c=organize` deep-links a category (the footer uses it on phones).
  useEffect(() => {
    const read = () => setPill(parsePill(new URLSearchParams(window.location.search).get("c")));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);

  // Keep the active pill visible in the phone's scrolling row.
  useEffect(() => {
    const row = scroller.current;
    const el = pillRefs.current[TOOL_PILLS.indexOf(pill)];
    if (!row || !el || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({
      left: el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [pill, reduce]);

  // While cards that drop out fade away, the grid keeps its height, so the
  // footer doesn't jump up under them; it is released once they have gone.
  const grid = useRef<HTMLDivElement>(null);
  function holdHeight() {
    const el = grid.current;
    if (el) el.style.minHeight = `${el.offsetHeight}px`;
  }
  function releaseHeight() {
    if (grid.current) grid.current.style.minHeight = "";
  }

  function select(next: ToolPill) {
    holdHeight();
    setPill(next);
    const url = new URL(window.location.href);
    if (next === "all") url.searchParams.delete("c");
    else url.searchParams.set("c", next);
    window.history.replaceState(window.history.state, "", url);
  }

  const filtered = useMemo(() => filterTools(TOOLS, pill, query), [pill, query]);

  // Nothing leaving means no exit to wait for, and "No match" belongs right
  // under the search: in both cases the grid sizes itself at once.
  const shown = useRef(filtered.map((t) => t.slug));
  useLayoutEffect(() => {
    const now = filtered.map((t) => t.slug);
    const leaving = shown.current.some((slug) => !now.includes(slug));
    shown.current = now;
    if (!leaving || !now.length) releaseHeight();
  }, [filtered]);

  // Screen readers hear the result count once typing pauses.
  const [status, setStatus] = useState("");
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    const t = setTimeout(
      () => setStatus(filtered.length ? `${filtered.length} tool${filtered.length === 1 ? "" : "s"}` : "No match"),
      400
    );
    return () => clearTimeout(t);
  }, [filtered]);

  return (
    <div>
      <p className="sr-only" aria-live="polite">
        {status}
      </p>
      <div className="mx-auto mb-8 flex max-w-5xl flex-col items-center gap-4">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => {
              holdHeight();
              setQuery(e.target.value);
            }}
            placeholder="Search tools"
            aria-label="Search tools"
            className="h-12 w-full rounded-full border border-input bg-background pl-11 pr-12 text-sm shadow-sm outline-none transition-shadow focus:ring-2 focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
          />
          {/* A plain wrapper centres the button; motion owns the button's transform. */}
          <span className="absolute inset-y-0 right-0.5 flex items-center">
            <AnimatePresence>
              {query && (
                <motion.button
                  type="button"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6, transition: EXIT_T }}
                  transition={{ ...ENTER_T, duration: DUR.fast }}
                  onClick={() => {
                    holdHeight();
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </motion.button>
              )}
            </AnimatePresence>
          </span>
        </div>

        <div
          ref={scroller}
          role="radiogroup"
          aria-label="Tool categories"
          className="scrollbar-none relative -mx-8 flex w-[calc(100%+4rem)] snap-x gap-1.5 overflow-x-auto px-8 [mask-image:linear-gradient(90deg,transparent,#000_2rem,#000_calc(100%-2rem),transparent)] sm:mx-0 sm:w-auto sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 sm:[mask-image:none]"
          onKeyDown={(e) => {
            const i = TOOL_PILLS.indexOf(pill);
            const next = rovingIndex(e.key, i, TOOL_PILLS.length);
            if (next === null) return;
            e.preventDefault();
            select(TOOL_PILLS[next]);
            pillRefs.current[next]?.focus();
          }}
        >
          {TOOL_PILLS.map((p, i) => {
            const active = pill === p;
            return (
              <button
                key={p}
                ref={(el) => {
                  pillRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                onClick={() => select(p)}
                className={cn(
                  "relative h-11 shrink-0 snap-center whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:h-9 sm:pointer-coarse:h-11",
                  active ? "text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="category-pill"
                    className="absolute inset-0 rounded-full bg-primary shadow-md shadow-primary/30"
                    transition={SPRING_LAYOUT}
                  />
                )}
                <span className="relative">{pillLabel(p)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={grid} className={cn(GRID, "relative content-start")}>
        <AnimatePresence mode="popLayout" initial={false} onExitComplete={releaseHeight}>
          {filtered.map((tool, i) => (
            <motion.div
              key={tool.slug}
              layout="position"
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1, transition: { ...ENTER_T, delay: staggerDelay(i) } }}
              exit={{ opacity: 0, scale: 0.97, transition: EXIT_T }}
              transition={{ layout: SPRING_LAYOUT }}
            >
              <ToolCard tool={tool} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
      {filtered.length === 0 && (
        <motion.div
          key="none"
          initial={POP_IN.initial}
          animate={POP_IN.animate}
          exit={POP_IN.exit}
          className="flex flex-col items-center gap-3 py-16 text-muted-foreground"
        >
          <p>No match</p>
          <button
            type="button"
            onClick={() => {
              setQuery("");
              select("all");
              searchRef.current?.focus();
            }}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border border-border bg-card px-4 text-sm font-medium text-foreground transition-[border-color,transform] duration-200 hover:border-primary/50 hover:duration-100 active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:active:scale-100"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
