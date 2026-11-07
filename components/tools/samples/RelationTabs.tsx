"use client";

import { useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { motion, useReducedMotion } from "motion/react";
import { SPRING_LAYOUT, SPRING_POP } from "@/components/motion/primitives";
import { oldestSample, sampledSpan, TAB_ROLES, TABS } from "@/lib/samples/tabs";
import { musicBrainzRecordingUrl } from "@/lib/samples/links";
import type { Relation, Role, SongRef, Tab, TabCounts } from "@/lib/samples/types";
import { cn } from "@/lib/utils";
import { RelationRow } from "./RelationRow";

const TAB_LABEL: Record<Tab, string> = { samples: "Samples", sampled: "Sampled in", covers: "Covers", remixes: "Remixes" };
const SUBHEAD: Partial<Record<Role, string>> = { covers: "This covers", coveredBy: "Covered by", remixOf: "Remix of", remixedBy: "Remixed in" };
/** Rows shown before "Show all". */
const FIRST_ROWS = 50;

const years = (n: number) => `${n} ${n === 1 ? "year" : "years"}`;

/** One line of fact for the open tab, only from years we know. Its numbers are final from the start: a sentence never counts up. */
function fact(tab: Tab, song: SongRef, relations: Relation[]) {
  if (tab === "samples") {
    const dated = relations.filter((r) => r.role === "samples" && r.year);
    const oldest = oldestSample(relations, song.year);
    if (!oldest || oldest.apart === null) return null;
    if (dated.length === 1) {
      return (
        <>
          {song.title} ({song.year}) samples a {oldest.year} record, {oldest.apart === 0 ? "from the same year" : `${years(oldest.apart)} apart`}.
        </>
      );
    }
    return (
      <>
        Oldest sample: {oldest.year}{oldest.apart === 0 ? ", the same year" : `, ${years(oldest.apart)} earlier`}.
      </>
    );
  }
  if (tab === "sampled") {
    const s = sampledSpan(relations);
    if (!s.count) return null;
    const span = s.from && s.to ? (s.from === s.to ? `, in ${s.from}` : `, ${s.from}–${s.to}`) : "";
    return (
      <>
        Sampled {s.count} {s.count === 1 ? "time" : "times"}
        {span}.
      </>
    );
  }
  return null;
}

export function RelationTabs({
  song,
  relations,
  counts,
  tab,
  unchecked = null,
  onTab,
  onListen,
  onExplore,
}: {
  song: SongRef;
  relations: Relation[];
  counts: TabCounts;
  tab: Tab;
  /**
   * What an empty tab says when MusicBrainz wasn't asked about this song or
   * couldn't answer (busy, an error, the day's lookups used, not on it).
   * Its zero counts are left out then: nobody knows they're zero. Null once
   * MusicBrainz has answered.
   */
  unchecked?: string | null;
  onTab: (t: Tab) => void;
  onListen: (r: Relation) => void;
  onExplore: (r: Relation) => void;
}) {
  const reduce = useReducedMotion();
  const [all, setAll] = useState<Partial<Record<Tab, boolean>>>({});
  const total = counts.samples + counts.sampled + counts.covers + counts.remixes;
  const line = fact(tab, song, relations);

  return (
    <Tabs.Root value={tab} onValueChange={(v) => onTab(v as Tab)} data-testid="relation-tabs">
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 className="text-sm font-semibold">Connections</h2>
        {/* The success moment's one overshoot. */}
        <motion.span
          data-testid="total-badge"
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={SPRING_POP}
          className="inline-flex h-7 items-center rounded-full bg-primary px-2.5 text-xs font-semibold text-primary-foreground"
        >
          {total} found
        </motion.span>
      </div>
      <Tabs.List aria-label="Connections" className="grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1 sm:grid-cols-4">
        {TABS.map((t) => {
          const active = t === tab;
          return (
            <Tabs.Trigger
              key={t}
              value={t}
              data-testid={`tab-${t}`}
              className={cn(
                "relative flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-ring",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {active && (
                <motion.span layoutId="samples-tab-pill" className="absolute inset-0 bg-background shadow" style={{ borderRadius: 8 }} transition={SPRING_LAYOUT} />
              )}
              <span className="relative z-[1]">{TAB_LABEL[t]}</span>
              {(counts[t] > 0 || !unchecked) && <span className="relative z-[1] tabular-nums text-xs text-muted-foreground">{counts[t]}</span>}
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>
      {line && (
        <p className="pt-3 text-sm text-muted-foreground" data-testid="tab-fact">
          {line}
        </p>
      )}
      {TABS.map((t) => {
        const rows = relations.filter((r) => TAB_ROLES[t].includes(r.role));
        const shown = all[t] ? rows : rows.slice(0, FIRST_ROWS);
        return (
          <Tabs.Content key={t} value={t} className="pt-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {rows.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground" data-testid="empty-tab">
                <p>{unchecked ?? "Nothing on record yet."}</p>
                {song.mbid && !unchecked && (
                  <a
                    href={musicBrainzRecordingUrl(song.mbid)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Add it on MusicBrainz
                  </a>
                )}
              </div>
            ) : (
              TAB_ROLES[t].map((role) => {
                const group = shown.filter((r) => r.role === role);
                if (!group.length) return null;
                return (
                  <section key={role}>
                    {TAB_ROLES[t].length > 1 && (
                      <h3 className="pt-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">{SUBHEAD[role]}</h3>
                    )}
                    <ul className="divide-y divide-border">
                      {group.map((r) => (
                        <RelationRow
                          key={`${r.role}|${r.title}|${r.artist}`}
                          relation={r}
                          songYear={song.year}
                          index={shown.indexOf(r)}
                          onListen={onListen}
                          onExplore={onExplore}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })
            )}
            {rows.length > shown.length && (
              <button
                type="button"
                onClick={() => setAll((a) => ({ ...a, [t]: true }))}
                className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-border text-sm font-medium hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show all {rows.length}
              </button>
            )}
          </Tabs.Content>
        );
      })}
    </Tabs.Root>
  );
}
