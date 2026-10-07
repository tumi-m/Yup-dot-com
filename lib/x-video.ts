/**
 * Resolve the MP4 files behind a public X (Twitter) post, without logging in
 * and without the media worker.
 *
 * Sources, in order:
 *   1. cdn.syndication.twimg.com/tweet-result — X's embed endpoint (used by
 *      vercel/react-tweet and as yt-dlp's fallback).
 *   2. api.fxtwitter.com/2/status/<id> — FxTwitter's public API.
 *   3. api.vxtwitter.com — last resort.
 * None of these is an official API with an SLA, hence the fallbacks.
 *
 * Only https://video.twimg.com MP4s are ever returned, so the download proxy
 * can't be pointed anywhere else.
 */

export interface XVariant {
  url: string;
  bitrate: number;
  width: number | null;
  height: number | null;
}

import { cleanTitle } from "./media";

export interface XVideo {
  id: string;
  /** Which video of a post with several (1-based among its videos); null if it has one. */
  index: number | null;
  title: string;
  author: string | null;
  thumbnail: string | null;
  duration: number | null;
  /** GIFs on X are silent MP4s. */
  hasAudio: boolean;
  /** Best first. */
  variants: XVariant[];
}

export type XFailure = "not-found" | "unavailable" | "no-video" | "login-required" | "unreachable";

export class XResolveError extends Error {
  constructor(public readonly kind: XFailure) {
    super(kind);
  }
}

export const X_FAILURE_MESSAGE: Record<XFailure, string> = {
  "not-found": "That post doesn't exist, or the link is wrong.",
  unavailable: "That post was deleted or is restricted.",
  "no-video": "That post doesn't contain a video.",
  "login-required": "That post can only be viewed when signed in to X, so it can't be downloaded.",
  unreachable: "X isn't responding right now. Try again in a minute.",
};

/** Token for the syndication endpoint, exactly as react-tweet computes it. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, "");
}

export function isAllowedVideoUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "video.twimg.com" && /\.mp4$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** X encodes the size in the path: /vid/avc1/1280x720/abc.mp4 */
function sizeFromUrl(url: string): { width: number | null; height: number | null } {
  const m = url.match(/\/(\d{2,5})x(\d{2,5})\//);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
}

function finish(variants: XVariant[]): XVariant[] {
  const seen = new Set<string>();
  return variants
    .filter((v) => isAllowedVideoUrl(v.url) && !seen.has(v.url) && seen.add(v.url))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate);
}

function titleFrom(text: unknown, author: string | null): string {
  const clean = cleanTitle(typeof text === "string" ? text.replace(/https?:\/\/t\.co\/\S+/g, "") : "");
  if (clean) return clean.length > 90 ? `${clean.slice(0, 87)}…` : clean;
  return author ? `Video by @${author}` : "X video";
}

type Json = Record<string, any>;

/**
 * The media item a /video/N link means. As on X (and in yt-dlp), N counts
 * every media item of the post, photos included. A position that isn't a
 * video falls back to the first video.
 */
function pickMedia(all: Json[], index: number | null | undefined, isVideo: (m: Json) => boolean) {
  const videos = all.filter((m) => m && isVideo(m));
  const wanted = index ? all[index - 1] : undefined;
  const item = wanted && isVideo(wanted) ? wanted : videos[0];
  return { item, index: videos.length > 1 && item ? videos.indexOf(item) + 1 : null };
}

/** Parse a syndication tweet-result payload. Throws XResolveError for known dead ends. */
export function parseSyndication(id: string, json: Json | null, index?: number | null): XVideo | null {
  // Empty means "not found" — but X also returns {} to some cloud IPs, so
  // treat it as inconclusive and let the next source decide.
  if (!json || Object.keys(json).length === 0) return null;
  if (json.__typename === "TweetTombstone") throw new XResolveError("unavailable");
  const media: Json[] = [...(json.mediaDetails ?? []), ...(json.quoted_tweet?.mediaDetails ?? [])];
  const picked = pickMedia(media, index, (m) => m?.type === "video" || m?.type === "animated_gif");
  const item = picked.item;
  if (!item) throw new XResolveError("no-video");
  const author = json.user?.screen_name ?? null;
  const variants = finish(
    (item.video_info?.variants ?? [])
      .filter((v: Json) => v?.content_type === "video/mp4" && typeof v.url === "string")
      .map((v: Json) => ({ url: v.url, bitrate: Number(v.bitrate) || 0, ...sizeFromUrl(v.url) }))
  );
  if (!variants.length) return null;
  return {
    id,
    index: picked.index,
    title: titleFrom(json.text, author),
    author,
    thumbnail: item.media_url_https ?? null,
    duration: item.video_info?.duration_millis ? item.video_info.duration_millis / 1000 : null,
    hasAudio: item.type !== "animated_gif",
    variants,
  };
}

/** Parse an FxTwitter v2 (`status`) or v1 (`tweet`) payload. */
export function parseFxTwitter(id: string, json: Json | null, index?: number | null): XVideo | null {
  if (!json) return null;
  if (json.code === 404) throw new XResolveError("not-found");
  if (json.code === 401 || json.code === 403) throw new XResolveError("login-required");
  const status = json.status ?? json.tweet;
  if (!status) return null;
  // media.all lists photos and videos in post order; older payloads only have videos.
  const all: Json[] = status.media?.all ?? status.media?.videos ?? [];
  const picked = pickMedia(all, status.media?.all ? index : null, (m) => m?.type === "video" || m?.type === "gif");
  const video: Json | undefined = picked.item ?? (status.media?.videos ?? [])[0];
  if (!video) throw new XResolveError("no-video");
  const author = status.author?.screen_name ?? null;
  const formats: Json[] = video.formats ?? video.variants ?? [];
  const variants = finish([
    ...formats
      .filter((f) => (f.container ?? "mp4") === "mp4" && (f.codec ?? "h264") === "h264" && typeof f.url === "string")
      .map((f) => ({ url: f.url, bitrate: Number(f.bitrate) || 0, width: f.width ?? null, height: f.height ?? null })),
    ...(typeof video.url === "string"
      ? [{ url: video.url, bitrate: 0, width: video.width ?? null, height: video.height ?? null }]
      : []),
  ]);
  if (!variants.length) return null;
  return {
    id,
    index: picked.item ? picked.index : null,
    title: titleFrom(status.text, author),
    author,
    thumbnail: video.thumbnail_url ?? null,
    duration: typeof video.duration === "number" ? video.duration : null,
    hasAudio: video.type !== "gif",
    variants,
  };
}

/** Parse a vxTwitter payload (shape unverified against live data; last resort). */
export function parseVxTwitter(id: string, json: Json | null, index?: number | null): XVideo | null {
  const media: Json[] = json?.media_extended ?? [];
  const picked = pickMedia(media, index, (m) => m?.type === "video" || m?.type === "gif");
  const item = picked.item;
  if (!item || typeof item.url !== "string") return null;
  const author = json?.user_screen_name ?? null;
  const variants = finish([
    { url: item.url, bitrate: 0, width: item.size?.width ?? null, height: item.size?.height ?? null },
  ]);
  if (!variants.length) return null;
  return {
    id,
    index: picked.index,
    title: titleFrom(json?.text, author),
    author,
    thumbnail: item.thumbnail_url ?? null,
    duration: item.duration_millis ? item.duration_millis / 1000 : null,
    hasAudio: item.type !== "gif",
    variants,
  };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(fetcher: Fetcher, url: string, headers: Record<string, string>): Promise<Json | null> {
  const res = await fetcher(url, { headers, signal: AbortSignal.timeout(8000), cache: "no-store" });
  if (res.status === 404) return url.includes("syndication") ? {} : { code: 404 };
  const text = await res.text();
  if (!res.ok && !text.trim().startsWith("{")) throw new Error(`HTTP ${res.status}`);
  return text.trim() ? JSON.parse(text) : {};
}

/** `index`: the media position from a /video/N link, if any. */
export async function resolveXVideo(id: string, fetcher: Fetcher = fetch, index?: number | null): Promise<XVideo> {
  if (!/^\d{1,25}$/.test(id)) throw new XResolveError("not-found");
  const UA = "Mozilla/5.0 (compatible; PDFWizard/1.0; +https://github.com/tumi-m/Yup-dot-com)";
  const sources: [string, () => Promise<XVideo | null>][] = [
    ["syndication", async () =>
      parseSyndication(id, await getJson(fetcher,
        `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`,
        { "User-Agent": "Googlebot" }), index)],
    ["fxtwitter", async () =>
      parseFxTwitter(id, await getJson(fetcher, `https://api.fxtwitter.com/2/status/${id}`, { "User-Agent": UA }), index)],
    ["vxtwitter", async () =>
      parseVxTwitter(id, await getJson(fetcher, `https://api.vxtwitter.com/i/status/${id}`, { "User-Agent": UA }), index)],
  ];

  // A definitive answer from any source ("no video", "deleted") beats "unreachable",
  // but keep trying: one source can be wrong or rate-limited.
  let definitive: XFailure | null = null;
  for (const [, run] of sources) {
    try {
      const video = await run();
      if (video) return video;
    } catch (err) {
      if (err instanceof XResolveError) definitive ??= err.kind;
    }
  }
  throw new XResolveError(definitive ?? "unreachable");
}

export function xFilename(video: XVideo, ext: "mp4" | "mp3", height?: number | null): string {
  const post = video.index ? `${video.id}-${video.index}` : video.id;
  const base = (video.author ? `${video.author}-${post}` : `x-${post}`).replace(/[^\w.-]+/g, "_");
  return `${base}${ext === "mp4" && height ? `-${height}p` : ""}.${ext}`;
}

/** "720p" means the short side, so portrait clips (720x1280) count as 720p. */
export function variantQuality(v: XVariant): number {
  if (v.width && v.height) return Math.min(v.width, v.height);
  return v.height ?? 720;
}

/** Which of the offered qualities this post really has (±15%); never none. */
export function xAvailableQualities(video: XVideo, offered: readonly number[]): number[] {
  const ps = video.variants.map(variantQuality);
  const hits = offered.filter((h) => ps.some((p) => p >= h * 0.85 && p <= h * 1.15));
  if (hits.length) return hits;
  const top = Math.max(...ps);
  return [offered.reduce((a, b) => (Math.abs(b - top) < Math.abs(a - top) ? b : a))];
}

/** Best variant at or below the requested quality, else the smallest. */
export function pickXVariant(video: XVideo, height: number): XVariant {
  return (
    video.variants.find((v) => variantQuality(v) <= height * 1.15) ??
    video.variants[video.variants.length - 1]
  );
}

/** Smallest download that still carries the full audio track. */
export function audioSourceVariant(video: XVideo): XVariant {
  const withBitrate = video.variants.filter((v) => v.bitrate > 0);
  const pool = withBitrate.length ? withBitrate : video.variants;
  return pool.reduce((a, b) => (variantQuality(b) < variantQuality(a) ? b : a));
}
