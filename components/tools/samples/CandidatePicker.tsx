"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ENTER_T, RESIZE_T, staggerDelay } from "@/components/motion/primitives";
import type { Candidate } from "@/lib/samples/types";
import { cn } from "@/lib/utils";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const field = "h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

/**
 * "Which song is this?": the songs the search found, and a form to type the
 * song instead, filled in from what was read.
 */
export function CandidatePicker({
  heading,
  candidates,
  current,
  typed,
  busy,
  note,
  onPick,
  onType,
  onCancel,
  headingRef,
}: {
  heading: string;
  candidates: Candidate[];
  /** The song shown now, left out of the list. */
  current?: string | null;
  typed: { artist: string; title: string };
  busy: boolean;
  note?: string | null;
  onPick: (c: Candidate) => void;
  onType: (song: { artist: string; title: string }) => void;
  onCancel?: () => void;
  headingRef?: (el: HTMLElement | null) => void;
}) {
  const [artist, setArtist] = useState(typed.artist);
  const [title, setTitle] = useState(typed.title);
  const list = candidates.filter((c) => c.mbid !== current).slice(0, 5);
  return (
    <motion.div
      layout
      transition={{ layout: RESIZE_T }}
      data-testid="candidate-picker"
      // Escape closes it, like "Keep this song", when it can be closed.
      onKeyDown={(e) => {
        if (e.key === "Escape" && onCancel) {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="rounded-3xl border border-border bg-card p-4 shadow-xl shadow-primary/5 sm:p-5"
    >
      <h2 ref={headingRef} tabIndex={-1} className="rounded text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {heading}
      </h2>
      {note && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
      {list.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Songs found">
          {list.map((c, i) => (
            <motion.li key={c.mbid} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...ENTER_T, delay: staggerDelay(i) }}>
              <button
                type="button"
                data-testid="candidate"
                disabled={busy}
                onClick={() => onPick(c)}
                className={cn(
                  "flex min-h-14 w-full items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-2 text-left transition-colors duration-fast hover:border-primary/50 disabled:opacity-60",
                  focusRing
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{c.title}</span>
                  <span className="block truncate text-sm text-muted-foreground">
                    {c.artist}
                    {c.year ? ` · ${c.year}` : ""}
                    {c.disambiguation ? ` · ${c.disambiguation}` : ""}
                  </span>
                </span>
              </button>
            </motion.li>
          ))}
        </ul>
      )}
      <form
        className="mt-4 border-t border-border pt-4"
        data-testid="type-it"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) onType({ artist: artist.trim(), title: title.trim() });
        }}
      >
        <p className="mb-2 text-sm font-medium">Type it</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="sr-only" htmlFor="type-artist">
            Artist
          </label>
          <input id="type-artist" value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="Artist" autoComplete="off" maxLength={200} className={field} />
          <label className="sr-only" htmlFor="type-title">
            Song title
          </label>
          <input id="type-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Song title" autoComplete="off" maxLength={200} className={field} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="motion-safe:animate-spin" /> : <Search />} Find this song
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
              Keep this song
            </Button>
          )}
        </div>
      </form>
    </motion.div>
  );
}
