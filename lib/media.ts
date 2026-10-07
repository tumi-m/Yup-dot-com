/**
 * YouTube and X (Twitter) downloads, shared by the API routes and the UI.
 * X posts are resolved by the web app itself (lib/x-video.ts); YouTube needs
 * the separate media worker (media-worker/), because yt-dlp and ffmpeg can't
 * run on serverless.
 */

export type MediaPlatform = "youtube" | "x";
export type MediaKind = "mp4" | "mp3";

export interface ParsedMediaUrl {
  platform: MediaPlatform;
  id: string;
  /** Normalised URL sent to the worker — never the raw user input. */
  canonical: string;
  /** X: the media position a /video/N or /photo/N link points at (1-based). */
  index?: number;
}

const YT_ID = /^[\w-]{11}$/;

/**
 * Accepts the link shapes people actually paste and rebuilds a canonical URL,
 * so arbitrary hosts or paths can never reach the worker.
 */
export function parseMediaUrl(input: string): ParsedMediaUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim().replace(/^(?!https?:\/\/)/i, "https://"));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return YT_ID.test(id) ? yt(id) : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const v = url.searchParams.get("v");
    if (v && YT_ID.test(v)) return yt(v);
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    return m ? yt(m[1]) : null;
  }
  if (host === "x.com" || host === "twitter.com") {
    const m = url.pathname.match(/^\/(?:[\w]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})(?:\/(?:video|photo)\/([1-9]))?/);
    if (!m) return null;
    const index = m[2] ? Number(m[2]) : undefined;
    return {
      platform: "x",
      id: m[1],
      canonical: `https://x.com/i/status/${m[1]}${index ? `/video/${index}` : ""}`,
      ...(index ? { index } : {}),
    };
  }
  return null;
}

function yt(id: string): ParsedMediaUrl {
  return { platform: "youtube", id, canonical: youtubeWatchUrl(id) };
}

export function youtubeWatchUrl(id: string) {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function isYoutubeId(id: unknown): id is string {
  return typeof id === "string" && YT_ID.test(id);
}

/** Longest playlist the worker lists. Longer ones are cut and flagged. */
export const PLAYLIST_MAX = 200;

export interface ParsedPlaylistUrl {
  id: string;
  /** Normalised URL sent to the worker — never the raw user input. */
  canonical: string;
  /** Set when the link also names one video (watch?v=…&list=…). */
  video: ParsedMediaUrl | null;
}

/**
 * Playlist ids: PL…, OLAK5uy_…, UU…, FL…, RD… mixes. "LL" and "WL" (liked,
 * watch later) are private to their owner, so the length floor drops them.
 */
const LIST_ID = /^[\w-]{10,64}$/;

/** youtube.com/playlist?list=…, or any video link that carries &list=…. */
export function parsePlaylistUrl(input: string): ParsedPlaylistUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim().replace(/^(?!https?:\/\/)/i, "https://"));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, "");
  if (host !== "youtube.com" && host !== "youtu.be") return null;
  const list = url.searchParams.get("list");
  if (!list || !LIST_ID.test(list)) return null;
  const video = parseMediaUrl(input);
  if (host === "youtube.com" && !["/playlist", "/watch"].includes(url.pathname) && !video) return null;
  if (host === "youtu.be" && !video) return null;
  return { id: list, canonical: `https://www.youtube.com/playlist?list=${list}`, video };
}

export const QUALITIES = [360, 480, 720, 1080] as const;
export type Quality = (typeof QUALITIES)[number];

/** The highest quality each tier can download. 1080p is the Pro upsell. */
export function maxHeightFor(tier: string): Quality {
  return tier === "pro" || tier === "team" ? 1080 : 720;
}

/**
 * Titles from YouTube and X shown in the page. Bidi overrides and other
 * invisible format characters are removed, so "\u202Egnp.exe" can't pose as
 * "exe.png"; zero-width joiners stay, so emoji sequences survive.
 */
export function cleanTitle(text: unknown): string {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const PLATFORM_LABEL: Record<MediaPlatform, string> = {
  youtube: "YouTube",
  x: "X (Twitter)",
};
