/**
 * MusicBrainz (musicbrainz.org/ws/2), the open music database the Sample
 * Finder reads connections from. Its data is CC0.
 *
 * Etiquette it asks for, and gets: a User-Agent naming the site, at most
 * about one request a second (each server instance queues its requests 1.1s
 * apart, and a site-wide budget keeps all instances together under it), one
 * retry after a 503, and caching (lib/samples/cache.ts). Only artist names
 * and song titles are sent; never anything about the visitor.
 *
 * Only fixed URLs on musicbrainz.org are built here: ids are checked to be
 * MusicBrainz ids and search text is escaped, so nothing a visitor types can
 * point a request elsewhere.
 */
import "server-only";
import { siteUrl } from "../site";
import { parseMediaUrl } from "../media";
import { compact, dice, escapeLucene, norm } from "./normalize";
import { creditNames } from "./catalog";
import type { Candidate, ParsedSong, Relation, Variant } from "./types";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://musicbrainz.org/ws/2";
export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** MusicBrainz didn't answer in time, refused (503), or the queue is too long. */
export class MusicBrainzBusy extends Error {
  constructor(public readonly reason: "queue" | "budget" | "unavailable" | "unreachable" | "error") {
    super(`MusicBrainz busy: ${reason}`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Spaces this instance's requests at least `gap` ms apart, in the order they
 * asked. A request that would wait longer than `maxWait` isn't queued.
 */
export class Throttle {
  private next = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    readonly gap = 1100,
    readonly maxWait = 6000
  ) {}

  /** Waits for this request's turn. False (and nothing reserved) when the wait would be too long. */
  async turn(): Promise<boolean> {
    const t = this.now();
    const at = Math.max(t, this.next);
    if (at - t > this.maxWait) return false;
    this.next = at + this.gap;
    if (at > t) await this.sleep(at - t);
    return true;
  }
}

/** One queue per server instance. */
const sharedThrottle = new Throttle();

/** `PDFWizard/1.0 ( https://site/contact )`. MUSICBRAINZ_CONTACT may name another https page; never an email. */
export function musicBrainzUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  let contact = `${env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "") || siteUrl()}/contact`;
  const given = env.MUSICBRAINZ_CONTACT?.trim();
  if (given) {
    try {
      const u = new URL(given);
      if (u.protocol === "https:" && !u.username && !u.password) contact = u.toString();
    } catch {
      /* not a URL: keep the site's contact page */
    }
  }
  return `PDFWizard/1.0 ( ${contact} )`;
}

/* ------------------------------------------------------------------ */
/* What the client returns                                             */
/* ------------------------------------------------------------------ */

/** A search hit, trimmed to what we use (this is what the cache keeps). */
export interface FoundRecording {
  id: string;
  title: string;
  artist: string;
  /** Each credited artist's name. */
  artists: string[];
  score: number;
  date: string | null;
  disambiguation: string;
  /** The release group of its earliest release, preferring albums and singles. */
  releaseGroupId: string | null;
  /** How many releases it is on (a rough sign of the main version). */
  releases: number;
}

/** A recording looked up with its connections (what the cache keeps). */
export interface RecordingDetail {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  relations: Relation[];
  /** A YouTube video MusicBrainz links to this recording. */
  listen: string | null;
}

/* ------------------------------------------------------------------ */
/* Parsing MusicBrainz's JSON                                          */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export function creditString(credit: Json): string {
  if (!Array.isArray(credit)) return "";
  return credit
    .map((c: Json) => `${typeof c?.name === "string" ? c.name : (c?.artist?.name ?? "")}${typeof c?.joinphrase === "string" ? c.joinphrase : ""}`)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function creditArtists(credit: Json): string[] {
  if (!Array.isArray(credit)) return [];
  return credit.map((c: Json) => String(c?.artist?.name ?? c?.name ?? "").trim()).filter(Boolean);
}

export function yearOf(date: unknown): number | null {
  const m = typeof date === "string" ? /^(\d{4})/.exec(date) : null;
  const y = m ? Number(m[1]) : NaN;
  return y >= 1000 && y <= 2100 ? y : null;
}

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function parseSearch(json: Json): FoundRecording[] {
  const list: Json[] = Array.isArray(json?.recordings) ? json.recordings : [];
  const out: FoundRecording[] = [];
  for (const r of list) {
    if (typeof r?.id !== "string" || !MBID.test(r.id) || !str(r.title)) continue;
    const releases: Json[] = Array.isArray(r.releases) ? r.releases : [];
    const ranked = releases
      .filter((rel) => typeof rel?.["release-group"]?.id === "string" && MBID.test(rel["release-group"].id))
      .map((rel) => ({
        id: rel["release-group"].id as string,
        main: ["Album", "Single", "EP"].includes(rel["release-group"]["primary-type"]) && !(rel["release-group"]["secondary-types"] ?? []).length,
        date: str(rel.date) || "9999",
      }))
      .sort((a, b) => Number(b.main) - Number(a.main) || a.date.localeCompare(b.date));
    out.push({
      id: r.id,
      title: str(r.title),
      artist: creditString(r["artist-credit"]),
      artists: creditArtists(r["artist-credit"]),
      score: Math.max(0, Math.min(100, Number(r.score) || 0)),
      date: str(r["first-release-date"]) || null,
      disambiguation: str(r.disambiguation),
      releaseGroupId: ranked[0]?.id ?? null,
      releases: releases.length,
    });
  }
  return out;
}

const attrs = (rel: Json): string[] => (Array.isArray(rel?.attributes) ? rel.attributes.map((a: unknown) => String(a).toLowerCase()) : []);

function relatedSong(target: Json, role: Relation["role"], rel: Json): Relation | null {
  const title = str(target?.title);
  if (!title) return null;
  const id = typeof target?.id === "string" && MBID.test(target.id) ? target.id : null;
  return {
    role,
    title,
    artist: creditString(target?.["artist-credit"]),
    year: yearOf(target?.["first-release-date"]) ?? yearOf(target?.date) ?? yearOf(rel?.begin),
    mbid: id,
    element: null,
    note: null,
    source: "musicbrainz",
  };
}

/** Most "covered by" rows kept for one song. */
export const COVERS_MAX = 30;

/**
 * The connections in a recording lookup (inc=recording-rels, work-rels and
 * work-level-rels):
 * - "samples material": forward, this recording samples the target;
 *   backward, the target samples it.
 * - "remix": forward, this recording is a remix of the target; backward,
 *   the target remixes it.
 * - a "performance" of a work with the "cover" attribute: this recording
 *   covers that work. The work's other performances marked "cover" cover
 *   this one, when this one isn't a cover itself.
 * Everything else (DJ-mix, mash-up, edit, karaoke, medley…) is left out.
 */
export function classifyRecording(json: Json): RecordingDetail | null {
  if (typeof json?.id !== "string" || !MBID.test(json.id)) return null;
  const relations: Relation[] = [];
  const artist = creditString(json["artist-credit"]);
  const own = new Set(creditArtists(json["artist-credit"]).map(compact));
  let listen: string | null = null;
  const coveredBy: Relation[] = [];

  for (const rel of Array.isArray(json.relations) ? json.relations : []) {
    const type = String(rel?.type ?? "").toLowerCase();
    const forward = rel?.direction !== "backward";
    const target = rel?.["target-type"];
    if (target === "recording" || target === "release") {
      const role = type === "samples material" ? (forward ? "samples" : "sampledBy") : type === "remix" ? (forward ? "remixOf" : "remixedBy") : null;
      if (!role) continue;
      const song = relatedSong(rel[target], role, rel);
      if (song) relations.push(song);
      continue;
    }
    if (target === "work" && type === "performance") {
      const work = rel.work;
      const performances: Json[] = Array.isArray(work?.relations)
        ? work.relations.filter((w: Json) => String(w?.type).toLowerCase() === "performance" && w?.["target-type"] === "recording" && w?.recording)
        : [];
      if (attrs(rel).includes("cover")) {
        // The original: a performance of the same work that isn't a cover (studio before live).
        const originals = performances
          .filter((w) => !attrs(w).includes("cover") && w.recording.id !== json.id && creditString(w.recording["artist-credit"]))
          .sort((a, b) => Number(attrs(a).includes("live")) - Number(attrs(b).includes("live")));
        const original = originals[0]?.recording;
        const title = str(work?.title);
        if (title) {
          relations.push({
            role: "covers",
            title,
            artist: original ? creditString(original["artist-credit"]) : "",
            year: original ? yearOf(original["first-release-date"]) : null,
            mbid: original && MBID.test(original.id) ? original.id : null,
            element: null,
            note: null,
            source: "musicbrainz",
          });
        }
        continue;
      }
      for (const w of performances) {
        if (!attrs(w).includes("cover") || w.recording.id === json.id) continue;
        const song = relatedSong(w.recording, "coveredBy", w);
        // A cover has to name who sang it; the artist's own other versions aren't covers.
        if (!song || !song.artist || creditArtists(w.recording["artist-credit"]).some((a) => own.has(compact(a)))) continue;
        coveredBy.push(song);
      }
      continue;
    }
    if (target === "url" && !listen && /free streaming|streaming|youtube/.test(type)) {
      const media = parseMediaUrl(str(rel?.url?.resource, 500));
      if (media?.platform === "youtube") listen = media.canonical;
    }
  }

  // One row per covering artist, at most COVERS_MAX.
  const seen = new Set<string>();
  for (const c of coveredBy) {
    const k = compact(creditNames(c.artist)[0] ?? c.artist);
    if (seen.has(k)) continue;
    seen.add(k);
    relations.push(c);
    if (seen.size >= COVERS_MAX) break;
  }

  return { id: json.id, title: str(json.title), artist, year: yearOf(json["first-release-date"]), relations, listen };
}

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

function words(text: string): string {
  return text
    .split(/\s+/)
    .map(escapeLucene)
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
}

/** A search that knows nothing about which words are the artist. */
export function freeTextQuery(text: string): string {
  const all = escapeLucene(text);
  const w = words(text);
  return `recording:"${all}" OR (recording:(${w}) AND artist:(${w}))`;
}

/** `recording:"<title>" AND artist:"<artist>"`, escaped; free text when the artist isn't known. */
export function recordingQuery(title: string, artist: string): string {
  if (!artist.trim()) return freeTextQuery(title);
  return `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(artist)}"`;
}

/** The one retry when the first search finds nothing: an alias, a single credited name, or free text. */
export function fallbackQuery(parsed: ParsedSong): string | null {
  if (!parsed.artist) return null;
  const alt = parsed.artistAliases[0] ?? parsed.artistParts[0];
  if (alt) return recordingQuery(parsed.title, alt);
  return freeTextQuery(`${parsed.artist} ${parsed.title}`);
}

/* ------------------------------------------------------------------ */
/* Picking the song                                                    */
/* ------------------------------------------------------------------ */

const VARIANT_WORDS = /\b(live|remix|demo|instrumental|acoustic|karaoke|a cappella|acapella|edit|mix|version|cover|rehearsal|session)\b/i;

function variantText(r: FoundRecording): boolean {
  return VARIANT_WORDS.test(r.disambiguation) || /[([].*\b(live|remix|demo|instrumental|acoustic|karaoke|edit|mix)\b.*[)\]]/i.test(r.title);
}

/** "Stronger (Live)" → "stronger": grouping ignores bracketed version names. */
function songTitleKey(title: string): string {
  return compact(title.replace(/\s*[([][^()[\]]*\b(live|remix|demo|instrumental|acoustic|karaoke|edit|mix|version|remaster(ed)?|mono|stereo)\b[^()[\]]*[)\]]/gi, ""));
}

/** How well a recording matches what was read: MusicBrainz's score × title likeness × artist likeness. */
export function matchScore(r: FoundRecording, parsed: ParsedSong): number {
  const s = r.score / 100;
  const plainTitle = r.title.replace(/\s*[([][^()[\]]*[)\]]\s*/g, " ").trim();
  if (!parsed.artist) {
    const text = parsed.title;
    return s * Math.max(dice(text, r.title), dice(text, plainTitle), dice(text, `${r.artist} ${r.title}`), dice(text, `${r.title} ${r.artist}`));
  }
  const title = Math.max(dice(parsed.title, r.title), dice(parsed.title, plainTitle));
  const ours = [parsed.artist, ...parsed.artistAliases, ...parsed.artistParts];
  const theirs = [r.artist, ...r.artists];
  let artist = 0;
  for (const a of ours) for (const b of theirs) artist = Math.max(artist, dice(a, b));
  return s * title * artist;
}

/**
 * Groups search hits into songs (same artist, same title), best first. The
 * song's main recording is its earliest that isn't a live, remix or other
 * version, unless the video was one; the rest are kept as alternatives.
 */
export function groupCandidates(found: FoundRecording[], parsed: ParsedSong, max = 5): Candidate[] {
  const wantVariant: Variant | null = parsed.variant;
  const groups = new Map<string, FoundRecording[]>();
  for (const r of found) {
    const k = `${compact(r.artist)}|${songTitleKey(r.title)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Candidate[] = [];
  for (const members of groups.values()) {
    const studio = members.filter((m) => !variantText(m));
    const pool = wantVariant && ["live", "remix", "acoustic", "instrumental", "demo"].includes(wantVariant) ? members : studio.length ? studio : members;
    const ordered = [...pool].sort(
      (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || b.releases - a.releases || b.score - a.score
    );
    const main = ordered[0];
    const best = Math.max(...members.map((m) => matchScore(m, parsed)));
    const penalty = studio.length === 0 && !wantVariant ? 0.85 : 1;
    out.push({
      mbid: main.id,
      alt: members.filter((m) => m.id !== main.id).sort((a, b) => Number(variantText(a)) - Number(variantText(b)) || (a.date ?? "9999").localeCompare(b.date ?? "9999")).map((m) => m.id).slice(0, 3),
      artist: main.artist,
      title: main.title.replace(/\s*[([][^()[\]]*\b(remaster(ed)?|mono|stereo)\b[^()[\]]*[)\]]/gi, "").trim() || main.title,
      year: yearOf(main.date),
      releaseGroupId: main.releaseGroupId,
      score: Math.max(...members.map((m) => m.score)),
      match: Math.round(best * penalty * 1000) / 1000,
      disambiguation: main.disambiguation || null,
    });
  }
  return out.sort((a, b) => b.match - a.match || b.score - a.score).slice(0, max);
}

/** Two different songs score almost the same: not sure which one it is. */
export function ambiguous(candidates: Candidate[]): boolean {
  const [a, b] = candidates;
  return !!a && !!b && a.match - b.match < 0.05 && compact(a.artist) !== compact(b.artist);
}

/* ------------------------------------------------------------------ */
/* The client                                                          */
/* ------------------------------------------------------------------ */

export interface MusicBrainzDeps {
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  throttle?: Throttle;
  /** The site-wide minute budget (lib/usage.ts claimMusicBrainz); false when it's spent. */
  claim?: () => Promise<boolean>;
  userAgent?: string;
  /** Per request. */
  timeoutMs?: number;
}

export interface MusicBrainz {
  search(query: string, limit?: number): Promise<FoundRecording[]>;
  /** null: no such recording. */
  recording(id: string): Promise<RecordingDetail | null>;
}

/** The most of an answer we read (a much-covered song's lookup can be large). */
const MAX_BYTES = 4_000_000;

export function createMusicBrainz(deps: MusicBrainzDeps = {}): MusicBrainz {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const throttle = deps.throttle ?? sharedThrottle;
  const ua = deps.userAgent ?? musicBrainzUserAgent();

  async function get(path: string, params: Record<string, string>): Promise<Json | null> {
    const url = `${BASE}${path}?${new URLSearchParams({ ...params, fmt: "json" })}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await throttle.turn())) throw new MusicBrainzBusy("queue");
      if (deps.claim && !(await deps.claim())) throw new MusicBrainzBusy("budget");
      let res: Response;
      try {
        res = await fetcher(url, {
          headers: { "User-Agent": ua, Accept: "application/json" },
          signal: AbortSignal.timeout(deps.timeoutMs ?? 8000),
          redirect: "error",
          cache: "no-store",
        });
      } catch {
        throw new MusicBrainzBusy("unreachable");
      }
      if (res.status === 503 || res.status === 429) {
        await res.body?.cancel().catch(() => {});
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
        throw new MusicBrainzBusy("unavailable");
      }
      // 400 (a malformed id or query) and 404 both mean: nothing to show.
      if (res.status === 404 || res.status === 400) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new MusicBrainzBusy("error");
      }
      if (Number(res.headers.get("content-length")) > MAX_BYTES) {
        await res.body?.cancel().catch(() => {});
        throw new MusicBrainzBusy("error");
      }
      try {
        const text = await res.text();
        if (text.length > MAX_BYTES) throw new Error("too large");
        return JSON.parse(text);
      } catch {
        throw new MusicBrainzBusy("error");
      }
    }
    throw new MusicBrainzBusy("unavailable");
  }

  return {
    async search(query, limit = 15) {
      const json = await get("/recording", { query: query.slice(0, 600), limit: String(Math.min(25, Math.max(1, limit))) });
      return json ? parseSearch(json) : [];
    },
    async recording(id) {
      if (!MBID.test(id)) return null;
      const json = await get(`/recording/${id}`, { inc: "artist-credits+recording-rels+work-rels+work-level-rels+url-rels" });
      return json ? classifyRecording(json) : null;
    },
  };
}

/** The cache key for a search: the query, normalised, so spelling-only differences share one entry. */
export function searchKey(query: string): string {
  return `mbq:${norm(query).slice(0, 300)}`;
}
