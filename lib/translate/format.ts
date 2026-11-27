/**
 * What the page and /api/ai/translate agree on: how long a passage and a
 * request may be, how a request is counted against the day's allowance, and
 * the events the route streams back. Plain code with no imports: the page
 * loads it.
 */

/** Longest passage sent; longer paragraphs are split at sentence ends first. */
export const MAX_SEGMENT_CHARS = 1_200;
/** Characters in one request: about a page, so one answer fits well inside the time a request may take. */
export const MAX_BATCH_CHARS = 3_000;
/** Passages in one request: more makes models more likely to drop or merge some. */
export const MAX_BATCH_SEGMENTS = 40;
/** Requests run at once by one page. */
export const PARALLEL_BATCHES = 2;

/**
 * The allowance is counted in blocks of this many characters, each request
 * rounded up to a whole block. The page packs requests close to the limit,
 * so little is lost to rounding.
 */
export const CHARGE_UNIT = 500;

/** Ids the page gives passages: short, so they cost little in the prompt. */
export const SEGMENT_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** What a request of `chars` characters takes from the allowance. */
export function chargeFor(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARGE_UNIT) * CHARGE_UNIT;
}

/**
 * Newline-delimited JSON from the route, one event a line:
 * `segment` as each passage is translated, `missing` for passages the model
 * left out even after a second try, then `done`; or `error` at any point.
 */
export type TranslateEvent =
  | { type: "segment"; id: string; text: string }
  | { type: "missing"; ids: string[] }
  | { type: "done" }
  | { type: "error"; message: string };

/** One passage, as the page sends it. */
export interface WireSegment {
  id: string;
  text: string;
}

export interface TranslateRequest {
  /** A language code from lib/translate/languages.ts. */
  target: string;
  /** A language code, or "auto" (the default) to let the model tell. */
  source?: string;
  segments: WireSegment[];
}

/** GET /api/ai/translate: whether translation runs here, and what is left today. */
export interface TranslateStatus {
  available: boolean;
  /** Characters left today, or null when unknown. */
  remaining: number | null;
  /** The plan's characters a day. */
  limit: number | null;
}
