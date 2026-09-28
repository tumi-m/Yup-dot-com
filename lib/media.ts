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
    const m = url.pathname.match(/^\/(?:[\w]{1,15}|i(?:\/web)?)\/status(?:es)?\/(\d{5,25})/);
    return m ? { platform: "x", id: m[1], canonical: `https://x.com/i/status/${m[1]}` } : null;
  }
  return null;
}

function yt(id: string): ParsedMediaUrl {
  return { platform: "youtube", id, canonical: `https://www.youtube.com/watch?v=${id}` };
}

export const QUALITIES = [360, 480, 720, 1080] as const;
export type Quality = (typeof QUALITIES)[number];

/** The highest quality each tier can download. 1080p is the Pro upsell. */
export function maxHeightFor(tier: string): Quality {
  return tier === "pro" || tier === "team" ? 1080 : 720;
}

export const PLATFORM_LABEL: Record<MediaPlatform, string> = {
  youtube: "YouTube",
  x: "X (Twitter)",
};
