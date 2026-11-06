/**
 * Puts the hand-checked list and MusicBrainz together: one row per
 * connection, the hand-checked one first (it says what was taken), with
 * MusicBrainz's id and year filled in where it has them.
 */
import { artistKey, compact } from "./normalize";
import { artistMatches, creditNames, titleMatches } from "./catalog";
import { ROLE_ORDER } from "./tabs";
import type { Relation, Role } from "./types";

export { ROLE_ORDER, TAB_ROLES, TABS, firstTab, oldestSample, sampledSpan, tabCounts, tabOf, yearsApart } from "./tabs";

/** Older first for what a song takes from; newest first for what took from it. */
const NEWEST_FIRST: Record<Role, boolean> = {
  samples: false,
  sampledBy: true,
  covers: false,
  coveredBy: true,
  remixOf: false,
  remixedBy: true,
};

function primaryArtist(credit: string): string {
  return artistKey(creditNames(credit)[0] ?? credit);
}

/** Role, title and first-credited artist, normalised. */
export function relationKey(r: Pick<Relation, "role" | "title" | "artist">): string {
  return `${r.role}|${compact(r.title)}|${primaryArtist(r.artist)}`;
}

function sameConnection(a: Relation, b: Relation): boolean {
  return a.role === b.role && (relationKey(a) === relationKey(b) || (titleMatches(b.title, a.title) && artistMatches(b.artist, a.artist)));
}

function byYear(newestFirst: boolean) {
  return (a: Relation, b: Relation) => {
    if (a.year === b.year) return 0;
    if (a.year === null || a.year === undefined) return 1;
    if (b.year === null || b.year === undefined) return -1;
    return newestFirst ? b.year - a.year : a.year - b.year;
  };
}

/**
 * Catalog rows first, then MusicBrainz's, sorted by year within each role.
 * A MusicBrainz row for a connection the catalog has only adds its id and,
 * if the catalog had none, its year.
 */
export function mergeRelations(catalog: Relation[], mb: Relation[]): Relation[] {
  const kept: Relation[] = [];
  const seen = new Set<string>();
  for (const r of catalog) {
    const k = relationKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push({ ...r });
  }
  const extra: Relation[] = [];
  for (const r of mb) {
    const match = kept.find((c) => sameConnection(c, r));
    if (match) {
      match.mbid ??= r.mbid ?? null;
      match.year ??= r.year;
      continue;
    }
    const k = relationKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    extra.push({ ...r });
  }
  const out: Relation[] = [];
  for (const role of ROLE_ORDER) {
    out.push(...kept.filter((r) => r.role === role));
    out.push(...extra.filter((r) => r.role === role).sort(byYear(NEWEST_FIRST[role])));
  }
  return out;
}

