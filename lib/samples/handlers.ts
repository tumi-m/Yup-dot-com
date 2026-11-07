/**
 * The Sample Finder's two routes, with everything they touch injectable so
 * tests can run them without a network or a database.
 *
 * POST /api/samples/identify {input}: which song a link or some text is.
 *   Costs only a per-minute allowance: reading a title and one search.
 * POST /api/samples/lookup {rec, artist, title, ticket?, alt?, cacheOnly?}:
 *   the song's connections. Spends one of the day's lookups, except for
 *   another pick for the same search, the same song again, an answer
 *   served from the cache, and the hand-checked list, which are free.
 */
import "server-only";
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { linkIn, parseMediaUrl, parsePlaylistUrl, type ParsedMediaUrl } from "../media";
import type { Tier } from "../limits";
import { signingSecret, signToken, verifyToken } from "../media-server";
import {
  MEDIA_LOOKUP_MESSAGE,
  SAMPLE_IDENTIFY_MESSAGE,
  claimMediaLookup,
  claimMusicBrainz,
  claimSampleIdentify,
  claimSampleLookup,
  type UsageStore,
} from "../usage";
import { DirectResolveError, type DirectFailure } from "../social/types";
import { resolveTikTokMusic } from "../social/tiktok";
import { catalogYear, lookupCatalog } from "./catalog";
import { INPUT_HELP, PLAYLIST_MESSAGE, linkProblem, tiktokPhotoLink } from "./links";
import { mergeRelations, tabCounts } from "./merge";
import {
  MBID,
  MusicBrainzBusy,
  Pause,
  type PauseStore,
  ambiguous,
  createMusicBrainz,
  fallbackQuery,
  groupCandidates,
  recordingQuery,
  searchKey,
  type Fetcher,
  type FoundRecording,
  type MusicBrainz,
  type RecordingDetail,
} from "./musicbrainz";
import { OEMBED_MESSAGE, OEmbedError, youtubeOEmbed, type OEmbedFailure, type OEmbedInfo } from "./oembed";
import { parseTyped, parseVideoTitle, tiktokMusicSlug } from "./parse";
import { TTL, sampleCache, type SampleCache } from "./cache";
import { artistKey, dice, hasWords, norm } from "./normalize";
import type { Band, Candidate, Identified, LookupResult, ParsedSong, Relation, SongRef, VideoInfo } from "./types";

export interface SampleDeps {
  resolveTier: () => Promise<{ user: { id: string } | null; tier: Tier }>;
  usageSubject: (request: Request, user: { id: string } | null) => string;
  /** Usage counters (lib/usage.ts); the shared default when left out. */
  store?: UsageStore;
  cache?: SampleCache;
  /** YouTube's oEmbed and TikTok. */
  fetcher?: Fetcher;
  /** The MusicBrainz client; by default one that queues, takes the site's one slot a second, and pauses after a refusal. */
  mb?: MusicBrainz;
  env?: NodeJS.ProcessEnv;
}

const noStore = { "Cache-Control": "private, no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...noStore, ...headers } });
}

function fail(status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json({ error, ...extra }, status, headers);
}

export { INPUT_HELP, PLAYLIST_MESSAGE };
export const ORIGINAL_SOUND_MESSAGE = "This TikTok uses an original sound, not a released song. Type the song if you know it.";
export const LOOKUP_LIMIT_MESSAGE = "You've used today's song lookups.";

const TIKTOK_MESSAGE: Record<DirectFailure, string> = {
  "not-found": "That TikTok doesn't exist, or the link is wrong.",
  unavailable: "That TikTok was deleted or is restricted.",
  "no-video": "That TikTok has no sound to read.",
  "login-required": "That TikTok is private, so its sound can't be read.",
  blocked: "TikTok didn't let us read that post. Type the song instead.",
  unreachable: "TikTok isn't answering right now. Type the song instead.",
};

/** The kill switch: SAMPLES_MB_DISABLED=1 serves the hand-checked list only. */
export function musicBrainzOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SAMPLES_MB_DISABLED === "1";
}

export function band(confidence: number): Band {
  return confidence >= 0.8 ? "high" : confidence >= 0.55 ? "medium" : "low";
}

/* ------------------------------------------------------------------ */
/* Tickets: a later pick for the same search is free                   */
/* ------------------------------------------------------------------ */

const ticketKey = () => createHmac("sha256", signingSecret()).update("pdf-wizard/sample-ticket/v1").digest("base64url");
const inputHash = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);

/** Signed, so a lookup can only claim "same search" for the songs that search really offered. */
export function issueTicket(inputKey: string, candidates: Candidate[]): string | null {
  const ids = [...new Set(candidates.flatMap((c) => [c.mbid, ...c.alt]))];
  return ids.length ? signToken({ k: inputHash(inputKey), c: ids }, ticketKey(), 24 * 60 * 60) : null;
}

function readTicket(ticket: string | null | undefined): { k: string; c: string[] } | null {
  if (!ticket) return null;
  const t = verifyToken<{ k?: unknown; c?: unknown }>(ticket, ticketKey());
  if (!t || typeof t.k !== "string" || !Array.isArray(t.c)) return null;
  return { k: t.k, c: t.c.filter((x): x is string => typeof x === "string") };
}

/* ------------------------------------------------------------------ */
/* Reading the input                                                   */
/* ------------------------------------------------------------------ */

type Reading =
  | { ok: true; source: Identified["source"]; video: VideoInfo | null; parsed: ParsedSong; inputKey: string }
  | { ok: false; status: number; error: string; typeIt?: boolean; headers?: Record<string, string> };

const LINKISH = /^(?:https?:\/\/|(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com|x\.com|twitter\.com|instagram\.com)\/)/i;

/** A tiktok.com/music/<Song-Name>-<id> link: the words in it, searched as free text. */
function tiktokMusicLink(link: string): { id: string; words: string } | null {
  try {
    const u = new URL(link.replace(/^(?!https?:\/\/)/i, "https://"));
    if (!/^(?:www\.|m\.)?tiktok\.com$/i.test(u.hostname)) return null;
    const words = tiktokMusicSlug(u.pathname);
    const id = /-(\d{8,25})\/?$/.exec(u.pathname)?.[1];
    return words && id ? { id, words } : null;
  } catch {
    return null;
  }
}

async function readYouTube(media: ParsedMediaUrl, link: string, cache: SampleCache, fetcher: Fetcher): Promise<Reading> {
  const key = `yt:${media.id}`;
  type Cached = OEmbedInfo | { error: OEmbedFailure };
  let info = await cache.get<Cached>(key);
  if (!info) {
    try {
      info = await youtubeOEmbed(media.id, fetcher);
      await cache.set(key, info, TTL.video);
    } catch (err) {
      const kind = err instanceof OEmbedError ? err.kind : "unreachable";
      if (kind !== "unreachable") await cache.set(key, { error: kind }, TTL.negative);
      info = { error: kind };
    }
  }
  if ("error" in info) {
    return { ok: false, status: info.error === "unreachable" ? 502 : 422, error: OEMBED_MESSAGE[info.error], typeIt: true };
  }
  const shorts = /\/shorts\//i.test(link);
  return {
    ok: true,
    source: "youtube",
    video: { platform: "youtube", id: media.id, title: info.title, channel: info.channel, thumbnail: info.thumbnail, url: media.canonical },
    parsed: parseVideoTitle(info.title, info.channel, { shorts }),
    inputKey: `yt:${media.id}`,
  };
}

async function readTikTok(media: ParsedMediaUrl, subject: string, deps: SampleDeps, cache: SampleCache, photo = false): Promise<Reading> {
  const key = `tt:${media.id}`;
  type Cached = Awaited<ReturnType<typeof resolveTikTokMusic>> | { error: DirectFailure };
  let post = await cache.get<Cached>(key);
  if (!post) {
    // Each one makes this server load a TikTok page.
    if (!(await claimMediaLookup(subject, deps.store))) {
      return { ok: false, status: 429, error: MEDIA_LOOKUP_MESSAGE, headers: { "Retry-After": "60" } };
    }
    try {
      post = await resolveTikTokMusic({ id: media.id, user: media.user ?? null, short: media.short ? media.canonical : null, photo }, deps.fetcher ?? fetch);
      await cache.set(key, post, TTL.video);
    } catch (err) {
      const kind: DirectFailure = err instanceof DirectResolveError ? err.kind : "unreachable";
      if (kind === "not-found" || kind === "unavailable" || kind === "login-required") await cache.set(key, { error: kind }, TTL.negative);
      post = { error: kind };
    }
  }
  if ("error" in post) {
    const down = post.error === "blocked" || post.error === "unreachable";
    return { ok: false, status: down ? 502 : 422, error: TIKTOK_MESSAGE[post.error], typeIt: true };
  }
  if (!post.music || post.music.original) return { ok: false, status: 422, error: ORIGINAL_SOUND_MESSAGE, typeIt: true };
  const typed = parseTyped(post.music.author ? `${post.music.author} – ${post.music.title}` : post.music.title);
  return {
    ok: true,
    source: "tiktok",
    video: {
      platform: "tiktok",
      id: post.id,
      title: post.title || "TikTok",
      channel: post.author ? `@${post.author}` : null,
      thumbnail: post.cover,
      url: `https://www.tiktok.com/@${post.author || "_"}/${post.photo ? "photo" : "video"}/${post.id}`,
    },
    // A sound's credit is whoever uploaded it, not always the artist.
    parsed: { ...typed, confidence: Math.min(typed.confidence, 0.6), signals: [...typed.signals, "tiktok-sound"] },
    inputKey: `tt:${post.id}`,
  };
}

async function readInput(input: string, subject: string, deps: SampleDeps, cache: SampleCache): Promise<Reading> {
  const link = linkIn(input);
  // A Spotify link, a channel or a profile: say what to paste instead.
  const problem = linkProblem(link);
  if (problem) return { ok: false, status: 400, error: problem };
  if (LINKISH.test(link)) {
    const music = tiktokMusicLink(link);
    if (music) {
      const parsed = parseTyped(music.words);
      // The slug is the sound's name in words, with no artist: a guess, searched as free text.
      return { ok: true, source: "tiktok", video: null, parsed: { ...parsed, confidence: Math.min(parsed.confidence, 0.2) }, inputKey: `ttm:${music.id}` };
    }
    const photo = tiktokPhotoLink(link);
    if (photo) {
      const media: ParsedMediaUrl = { platform: "tiktok", id: photo.id, user: photo.user, canonical: `https://www.tiktok.com/@${photo.user}/photo/${photo.id}` };
      return readTikTok(media, subject, deps, cache, true);
    }
    const media = parseMediaUrl(link);
    if (!media && parsePlaylistUrl(link)) return { ok: false, status: 400, error: PLAYLIST_MESSAGE };
    if (media?.platform === "youtube") return readYouTube(media, link, cache, deps.fetcher ?? fetch);
    if (media?.platform === "tiktok") return readTikTok(media, subject, deps, cache);
    return { ok: false, status: 400, error: INPUT_HELP };
  }
  if (input.length > 200) return { ok: false, status: 400, error: "That's too long. Type Artist – Title." };
  const parsed = parseTyped(input);
  if (!hasWords(parsed.title)) return { ok: false, status: 400, error: INPUT_HELP };
  return { ok: true, source: "text", video: null, parsed, inputKey: `q:${norm(input)}` };
}

/* ------------------------------------------------------------------ */
/* MusicBrainz, through the cache                                      */
/* ------------------------------------------------------------------ */

/** The pause after MusicBrainz refuses, kept in the shared cache so every server instance holds back. */
export function cachedPause(cache: SampleCache, now: () => number = Date.now): PauseStore {
  return {
    // Fresh: a copy in this instance's memory would hide a pause another instance has just started.
    get: async () => (await cache.get<{ until: number }>("mb:pause", { fresh: true }))?.until ?? null,
    set: (until) => cache.set("mb:pause", { until }, Math.max(1, Math.ceil((until - now()) / 1000))),
  };
}

let pause: Pause | null = null;
const sitePause = (cache: SampleCache) => (pause ??= new Pause(Date.now, cachedPause(cache)));

/** `subject`: who asked, so their requests take at most one place in the queue. */
function client(deps: SampleDeps, subject: string, cache: SampleCache): MusicBrainz {
  return deps.mb ?? createMusicBrainz({ fetcher: deps.fetcher, owner: subject, pause: sitePause(cache), claim: () => claimMusicBrainz(deps.store) });
}

async function cachedSearch(query: string, mb: MusicBrainz, cache: SampleCache): Promise<FoundRecording[]> {
  const key = searchKey(query);
  const hit = await cache.get<FoundRecording[]>(key);
  if (hit) return hit;
  const found = await mb.search(query);
  await cache.set(key, found, found.length ? TTL.search : TTL.negative);
  return found;
}

/** One search, and one more only when it found nothing. */
async function searchCandidates(parsed: ParsedSong, mb: MusicBrainz, cache: SampleCache): Promise<Candidate[]> {
  const first = recordingQuery(parsed.title, parsed.artist);
  let found = await cachedSearch(first, mb, cache);
  if (!found.length) {
    const second = fallbackQuery(parsed);
    if (second && second !== first) found = await cachedSearch(second, mb, cache);
  }
  return groupCandidates(found, parsed);
}

type CachedRecording = RecordingDetail | { missing: true };

async function cachedRecording(id: string, mb: MusicBrainz, cache: SampleCache): Promise<RecordingDetail | null> {
  const key = `mbrec:${id}`;
  const hit = await cache.get<CachedRecording>(key);
  if (hit) return "missing" in hit ? null : hit;
  const detail = await mb.recording(id);
  await cache.set(key, detail ?? { missing: true }, detail ? TTL.recording : TTL.negative);
  return detail;
}

async function fromCache(id: string, cache: SampleCache): Promise<RecordingDetail | null | undefined> {
  const hit = await cache.get<CachedRecording>(`mbrec:${id}`);
  if (!hit) return undefined;
  return "missing" in hit ? null : hit;
}

const hasSamplesOrRemixes = (d: RecordingDetail) => d.relations.some((r) => r.role !== "covers" && r.role !== "coveredBy");

/* ------------------------------------------------------------------ */
/* Identify                                                            */
/* ------------------------------------------------------------------ */

/** Readings clear enough to show when MusicBrainz looked and has no such song. */
const CLEAR_READING = ["typed-split", "typed-by", "typed-quoted", "channel-match", "topic"];

/**
 * Covers are often titled "Song - Original Artist (Cover)". When a song
 * found is that the other way round, the reading is turned round too, so
 * the form to type the song starts right.
 */
export function coverOrder(parsed: ParsedSong, candidates: Candidate[]): ParsedSong {
  if (parsed.variant !== "cover" || !parsed.artist) return parsed;
  const flipped = candidates.some((c) => dice(c.artist, parsed.title) >= 0.85 && dice(c.title, parsed.artist) >= 0.85);
  if (!flipped) return parsed;
  return { ...parsed, artist: parsed.title, title: parsed.artist, artistAliases: [], artistParts: [], signals: [...parsed.signals, "swapped"] };
}

/** A Short's hashtags ("#kanye") put the songs by that artist first. */
export function byHashtag(candidates: Candidate[], tags: string[] = []): Candidate[] {
  const keys = tags.map(artistKey).filter((t) => Array.from(t).length >= 3);
  if (!keys.length) return candidates;
  const named = (c: Candidate) => {
    const a = artistKey(c.artist);
    return keys.some((t) => a.includes(t) || (Array.from(a).length >= 3 && t.includes(a)));
  };
  return [...candidates.filter(named), ...candidates.filter((c) => !named(c))];
}

let identifySchema: z.ZodType<{ input: string }, z.ZodTypeDef, unknown> | null = null;

export async function handleIdentify(request: Request, deps: SampleDeps): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsedBody = (identifySchema ??= z.object({ input: z.string().trim().min(1).max(500) })).safeParse(body);
  if (!parsedBody.success) return fail(400, INPUT_HELP);
  const input = parsedBody.data.input;

  const { user } = await deps.resolveTier();
  const subject = deps.usageSubject(request, user);
  if (!(await claimSampleIdentify(subject, deps.store))) return fail(429, SAMPLE_IDENTIFY_MESSAGE, {}, { "Retry-After": "60" });

  const cache = deps.cache ?? sampleCache();
  const reading = await readInput(input, subject, deps, cache);
  if (!reading.ok) return fail(reading.status, reading.error, reading.typeIt ? { typeIt: true } : {}, reading.headers);
  let { parsed } = reading;

  let mb: Identified["mb"] = musicBrainzOff(deps.env) ? "off" : "ok";
  let candidates: Candidate[] = [];
  if (mb === "ok") {
    try {
      candidates = await searchCandidates(parsed, client(deps, subject, cache), cache);
    } catch (err) {
      if (!(err instanceof MusicBrainzBusy)) throw err;
      mb = "busy";
    }
  }
  parsed = coverOrder(parsed, candidates);
  candidates = byHashtag(candidates, parsed.hashtags);

  let pick: SongRef | null = null;
  let confidence: number;
  const top = candidates[0];
  if (top) {
    pick = { artist: top.artist, title: top.title, year: top.year ?? catalogYear(top), mbid: top.mbid };
    const listed = lookupCatalog(pick).length > 0;
    confidence = 0.5 * parsed.confidence + 0.5 * Math.min(1, top.match + (listed ? 0.1 : 0));
    // Two different songs fit about as well: ask rather than guess.
    if (ambiguous(candidates)) confidence = Math.min(confidence, 0.5);
  } else if (parsed.artist) {
    // Nothing from MusicBrainz (busy, off, or no such recording there): the
    // reading itself, sure only when the hand-checked list knows the song.
    pick = { artist: parsed.artist, title: parsed.title, year: catalogYear(parsed), mbid: null };
    const listed = lookupCatalog(pick).length > 0;
    confidence = mb === "ok" ? 0.5 * parsed.confidence + (listed ? 0.3 : 0) : parsed.confidence + (listed ? 0.1 : 0);
    // MusicBrainz looked and hasn't got it, but the reading is clear (typed
    // "Artist – Title", or split on the artist's own channel): show it, and
    // say MusicBrainz doesn't have it, rather than ask "Which song?" forever.
    if (mb === "ok" && parsed.confidence >= 0.7 && CLEAR_READING.some((s) => parsed.signals.includes(s))) confidence = Math.max(confidence, 0.6);
  } else {
    confidence = Math.min(parsed.confidence, 0.3);
  }
  confidence = Math.round(Math.min(1, Math.max(0, confidence)) * 100) / 100;

  const result: Identified = {
    source: reading.source,
    video: reading.video,
    parsed,
    candidates,
    pick,
    confidence,
    band: band(confidence),
    catalog: pick ? mergeRelations(lookupCatalog(pick), []) : [],
    mb,
    ticket: issueTicket(reading.inputKey, candidates),
  };
  return json(result);
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

interface LookupBody {
  rec?: string | null;
  alt?: string[];
  artist: string;
  title: string;
  ticket?: string | null;
  cacheOnly?: boolean;
}

let lookupSchema: z.ZodType<LookupBody, z.ZodTypeDef, unknown> | null = null;
function lookupBodySchema() {
  return (lookupSchema ??= z.object({
    rec: z.string().regex(MBID).nullish(),
    alt: z.array(z.string().regex(MBID)).max(3).optional(),
    artist: z.string().trim().max(200).default(""),
    title: z.string().trim().min(1).max(200),
    ticket: z.string().max(4000).nullish(),
    cacheOnly: z.boolean().optional(),
  }));
}

function answer(song: SongRef, catalog: Relation[], details: RecordingDetail[], mb: LookupResult["mb"], remaining: number | null, extra: Partial<LookupResult> = {}): LookupResult {
  const relations = mergeRelations(catalog, details.flatMap((d) => d.relations));
  return {
    song,
    relations,
    counts: tabCounts(relations),
    mb,
    listen: details.find((d) => d.listen)?.listen ?? null,
    remaining,
    ...extra,
  };
}

export async function handleLookup(request: Request, deps: SampleDeps): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsedBody = lookupBodySchema().safeParse(body);
  if (!parsedBody.success) return fail(400, "Pick a song first.");
  const { rec, artist, title } = parsedBody.data;

  const { user, tier } = await deps.resolveTier();
  const subject = deps.usageSubject(request, user);
  const cache = deps.cache ?? sampleCache();
  const catalog = lookupCatalog({ artist, title });
  const asked: SongRef = { artist, title, year: catalogYear({ artist, title }), mbid: rec ?? null };
  // Once MusicBrainz has the recording, its artist and title are the song's:
  // the hand-checked list is matched on those, never on what was sent.
  const song = (d: RecordingDetail | null): SongRef => {
    if (!d) return asked;
    const known = { artist: d.artist || artist, title: d.title || title };
    return { ...known, year: d.year ?? catalogYear(known), mbid: d.id };
  };
  const reply = (d: RecordingDetail | null, details: RecordingDetail[], mb: LookupResult["mb"], remaining: number | null, extra: Partial<LookupResult> = {}) => {
    const s = song(d);
    return answer(s, d ? lookupCatalog(s) : catalog, details, mb, remaining, extra);
  };

  // Shared links: only what is already cached, so opening one never spends
  // anyone's lookups. `cached` does tell anyone whether some visitor looked
  // this recording up in the last 30 days: a trade-off we accept, as the
  // cache holds songs only, never who asked.
  if (parsedBody.data.cacheOnly) {
    if (!(await claimSampleIdentify(subject, deps.store))) return fail(429, SAMPLE_IDENTIFY_MESSAGE, {}, { "Retry-After": "60" });
    const hit = rec ? await fromCache(rec, cache) : undefined;
    return json(reply(hit ?? null, hit ? [hit] : [], "ok", null, { cached: hit !== undefined }));
  }
  if (musicBrainzOff(deps.env)) return json(answer(asked, catalog, [], "off", null));
  // Not in MusicBrainz: the hand-checked list is all there is, and it's free.
  if (!rec) return json(answer(asked, catalog, [], "ok", null));

  const ticket = readTicket(parsedBody.data.ticket);
  const sameSearch = !!ticket && ticket.c.includes(rec);
  // A second recording of the same song is only tried when the search offered it.
  const alt = sameSearch ? (parsedBody.data.alt ?? []).filter((id) => id !== rec && ticket.c.includes(id)).slice(0, 1) : [];

  // Already cached: free.
  const cached = await fromCache(rec, cache);
  if (cached !== undefined) {
    const details = cached ? [cached] : [];
    if (!cached || hasSamplesOrRemixes(cached) || !alt.length) return json(reply(cached, details, "ok", null));
    const second = await fromCache(alt[0], cache);
    if (second !== undefined) return json(reply(cached, second ? [cached, second] : details, "ok", null));
  }

  const claim = await claimSampleLookup(subject, tier, sameSearch ? `in:${ticket.k}` : `rec:${rec}`, deps.store);
  if (!claim.allowed) {
    return json(
      { error: LOOKUP_LIMIT_MESSAGE, upgrade: tier !== "pro" && tier !== "team", reason: "samples", ...answer(asked, catalog, [], "ok", 0) },
      429
    );
  }
  const mb = client(deps, subject, cache);
  try {
    const first = cached === undefined ? await cachedRecording(rec, mb, cache) : cached;
    if (!first) {
      await claim.refund();
      return json(answer(asked, catalog, [], "ok", claim.remaining + (claim.free ? 0 : 1)));
    }
    const details = [first];
    if (!hasSamplesOrRemixes(first) && alt.length) {
      const second = await cachedRecording(alt[0], mb, cache);
      if (second) details.push(second);
    }
    return json(reply(first, details, "ok", claim.remaining));
  } catch (err) {
    await claim.refund();
    if (err instanceof MusicBrainzBusy) return json(answer(asked, catalog, [], "busy", null));
    throw err;
  }
}
