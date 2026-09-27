/**
 * YouTube and X (Twitter) downloads. The heavy lifting runs in the separate
 * media worker (media-worker/), because yt-dlp and ffmpeg can't run on
 * serverless. This module is shared by the API routes and the UI.
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

export function mediaWorkerUrl(): string | null {
  const url = process.env.MEDIA_WORKER_URL;
  return url ? url.replace(/\/$/, "") : null;
}

/** Signs one download: base64url(json) + "." + base64url(HMAC-SHA256). */
export async function signMediaToken(
  payload: { u: string; k: MediaKind; h: number },
  secret: string,
  ttlSeconds = 600
): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const body = Buffer.from(
    JSON.stringify({ ...payload, e: Math.floor(Date.now() / 1000) + ttlSeconds })
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
