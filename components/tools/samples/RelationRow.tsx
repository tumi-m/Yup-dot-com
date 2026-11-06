"use client";

import { motion, useReducedMotion } from "motion/react";
import { ExternalLink, Search } from "lucide-react";
import { DUR, ENTER_T, staggerDelay } from "@/components/motion/primitives";
import { yearsApart } from "@/lib/samples/tabs";
import { youtubeSearchUrl } from "@/lib/samples/links";
import type { Relation } from "@/lib/samples/types";
import { cn } from "@/lib/utils";
import { ElementChip } from "./ElementChip";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** One connection: the song, its year and what was taken, with Listen and Find its samples. */
export function RelationRow({
  relation,
  songYear,
  index,
  onListen,
  onExplore,
}: {
  relation: Relation;
  songYear: number | null;
  index: number;
  onListen: (r: Relation) => void;
  onExplore: (r: Relation) => void;
}) {
  const reduce = useReducedMotion();
  const apart = yearsApart(songYear, relation.year);
  const delay = reduce ? 0 : staggerDelay(index);
  return (
    <motion.li
      data-testid="relation-row"
      data-source={relation.source}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...ENTER_T, delay }}
      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-3"
    >
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium leading-snug">{relation.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {relation.artist || "Artist not listed"}
          {relation.year ? ` · ${relation.year}` : ""}
          {apart !== null && apart > 0 ? ` · ${apart} ${apart === 1 ? "year" : "years"} apart` : ""}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {relation.element && <ElementChip element={relation.element} delay={reduce ? 0 : delay + DUR.base} />}
          <span
            className={cn(
              "inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-medium",
              relation.source === "catalog" ? "border-emerald-300/70 text-emerald-800 dark:text-emerald-300" : "border-border text-muted-foreground"
            )}
          >
            {relation.source === "catalog" ? "Hand-checked" : "MusicBrainz"}
          </span>
        </div>
        {relation.note && <p className="mt-1.5 text-sm text-muted-foreground">{relation.note}</p>}
      </div>
      <div className="flex shrink-0 gap-1.5 sm:flex-col sm:items-stretch">
        <a
          data-testid="listen-link"
          href={youtubeSearchUrl(relation.artist, relation.title)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => onListen(relation)}
          className={cn(
            "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium transition-colors duration-fast hover:border-primary/50",
            focusRing
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Listen
          <span className="sr-only"> to {relation.title} on YouTube (opens a new tab)</span>
        </a>
        <button
          type="button"
          data-testid="explore"
          onClick={() => onExplore(relation)}
          className={cn(
            "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-primary transition-colors duration-fast hover:bg-accent",
            focusRing
          )}
        >
          <Search className="h-3.5 w-3.5" aria-hidden /> Find its samples
          <span className="sr-only">: {relation.title}</span>
        </button>
      </div>
    </motion.li>
  );
}
