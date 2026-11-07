/**
 * Shapes shared by the Sample Finder's server code and its page. Plain data,
 * so they travel as JSON.
 */

/** How a related song is connected to the one looked up. */
export type Role = "samples" | "sampledBy" | "covers" | "coveredBy" | "remixOf" | "remixedBy";

/** What a sample takes. "interpolation" means it was replayed or re-sung, not lifted from the record. */
export type SampleElement = "hook-riff" | "vocals-lyrics" | "drums" | "bass" | "multiple" | "sound-effect" | "interpolation";

export interface SongRef {
  artist: string;
  title: string;
  year: number | null;
  /** MusicBrainz recording id, when known. */
  mbid?: string | null;
}

export interface Relation extends SongRef {
  role: Role;
  element?: SampleElement | null;
  /** What was taken, in a few words (hand-checked entries only). */
  note?: string | null;
  /** "catalog": our hand-checked list. "musicbrainz": the open database. */
  source: "catalog" | "musicbrainz";
}

/** The kinds of version a video title can name. */
export type Variant =
  | "live"
  | "acoustic"
  | "demo"
  | "extended"
  | "instrumental"
  | "karaoke"
  | "sped-up"
  | "slowed"
  | "nightcore"
  | "8d"
  | "remix"
  | "cover";

/** A song read from a video title or typed text. */
export interface ParsedSong {
  artist: string;
  title: string;
  /** Other names for the artist, e.g. "방탄소년단" for BTS. */
  artistAliases: string[];
  /** The credited artists one by one ("A x B" → ["A", "B"]), when there are several. */
  artistParts: string[];
  featured: string[];
  variant: Variant | null;
  /** Who remixed it, for "(X Remix)". */
  remixer?: string | null;
  /** 0 to 1: how sure the reading is, before any database match. */
  confidence: number;
  /** Why: short machine labels, e.g. "topic", "split", "reaction". */
  signals: string[];
  /** A video title's hashtags ("#kanye" on a Short), used to put that artist's songs first. */
  hashtags?: string[];
}

/** One song a search found, with the recordings of it grouped. */
export interface Candidate extends SongRef {
  mbid: string;
  /** Other recordings of the same song, best first (tried when the first has no connections). */
  alt: string[];
  releaseGroupId: string | null;
  /** MusicBrainz's search score, 0 to 100. */
  score: number;
  /** How well it matches what was read, 0 to 1. */
  match: number;
  disambiguation?: string | null;
}

export type Band = "high" | "medium" | "low";

export interface VideoInfo {
  platform: "youtube" | "tiktok";
  id: string;
  title: string;
  channel: string | null;
  thumbnail: string | null;
  /** The video's own page: a canonical watch or post link, never what was pasted. */
  url: string;
}

/** POST /api/samples/identify answers with this. */
export interface Identified {
  source: "youtube" | "tiktok" | "text";
  video: VideoInfo | null;
  parsed: ParsedSong;
  candidates: Candidate[];
  pick: SongRef | null;
  confidence: number;
  band: Band;
  /** Hand-checked connections for the pick: free, shown at once. */
  catalog: Relation[];
  mb: "ok" | "busy" | "off";
  /** Binds a later lookup of any of these candidates to this one input, so picking another is free. */
  ticket: string | null;
}

/** POST /api/samples/lookup answers with this. */
export interface LookupResult {
  song: SongRef;
  relations: Relation[];
  counts: TabCounts;
  mb: "ok" | "busy" | "off";
  /** A video MusicBrainz links to this recording, if any. */
  listen: string | null;
  /** Lookups left today; null when this one was free. */
  remaining: number | null;
  /** cacheOnly requests: whether the full answer was in the cache. */
  cached?: boolean;
}

export type Tab = "samples" | "sampled" | "covers" | "remixes";

export type TabCounts = Record<Tab, number>;
