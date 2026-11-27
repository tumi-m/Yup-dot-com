/**
 * Video downloads, shared by the API routes and the UI. X, TikTok and
 * Instagram posts are resolved by the web app itself (lib/social/*); YouTube
 * needs the separate media worker (media-worker/), because yt-dlp and ffmpeg
 * can't run on serverless.
 */

export type MediaPlatform = "youtube" | "x" | "tiktok" | "instagram";

/**
 * YouTube is paused until the media worker is running reliably. Set
 * NEXT_PUBLIC_ENABLE_YOUTUBE=1 (and redeploy) to bring its tools back.
 */
export const YOUTUBE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_YOUTUBE === "1";
export type MediaKind = "mp4" | "mp3";

/** A plain host name, IPv4 address or bracketed IPv6 address: nothing a CSP would read as a wildcard or a new directive. */
const PLAIN_HOST = /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/;

/**
 * MEDIA_WORKER_URL as browsers are sent to it, or null when it isn't a URL.
 * Values pasted into a hosting dashboard often lack a scheme or say http;
 * the site is served over https, which blocks requests to http origins, so
 * anything but localhost becomes https. The download links (lib/media-server.ts)
 * and the pages' CSP (lib/csp.ts) both use this, so a page may reach the
 * address its links name. Its host goes into the CSP, so a wildcard, a
 * space or a ";" makes it no URL at all.
 */
export function workerUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !PLAIN_HOST.test(url.hostname)) return null;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) url.protocol = "https:";
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface ParsedMediaUrl {
  platform: MediaPlatform;
  id: string;
  /** Normalised URL sent to the worker — never the raw user input. */
  canonical: string;
  /** X: the media position a /video/N or /photo/N link points at (1-based). Instagram: ?img_index=N. */
  index?: number;
  /** TikTok: the @username in the link, if any. */
  user?: string;
  /** TikTok: a vm/vt/t short link; Instagram: a /share/ link. Expanded on the server; `canonical` is the short link. */
  short?: boolean;
}

const YT_ID = /^[\w-]{11}$/;

/**
 * The link in text pasted from a share sheet or a chat ("Check out this
 * video! https://vm.tiktok.com/…"), or the text itself when it has no
 * http(s) link. Only the link box uses this; the parsers stay strict.
 */
export function linkIn(text: string): string {
  const found = text.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  return found ? found.replace(/[.,;:!?)\]]+$/, "") : text.trim();
}

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
  if (url.hostname === "vm.tiktok.com" || url.hostname === "vt.tiktok.com") {
    const code = url.pathname.match(/^\/(\w{4,20})\/?$/)?.[1];
    return code ? { platform: "tiktok", id: code, short: true, canonical: `https://${url.hostname}/${code}/` } : null;
  }
  if (host === "tiktok.com") {
    const short = url.pathname.match(/^\/t\/(\w{4,20})\/?$/)?.[1];
    if (short) return { platform: "tiktok", id: short, short: true, canonical: `https://www.tiktok.com/t/${short}/` };
    const m = url.pathname.match(/^\/@([\w.-]{1,40})\/video\/(\d{8,25})/);
    if (m) return { platform: "tiktok", id: m[2], user: m[1], canonical: `https://www.tiktok.com/@${m[1]}/video/${m[2]}` };
    const e = url.pathname.match(/^\/(?:embed(?:\/v2)?|share\/video)\/(\d{8,25})/);
    return e ? { platform: "tiktok", id: e[1], canonical: `https://www.tiktok.com/@_/video/${e[1]}` } : null;
  }
  if (host === "instagram.com") {
    // The app's share links (/share/reel/…, /share/p/…, /share/…) carry their
    // own code, not the post's: they're followed on the server, like TikTok's.
    const share = url.pathname.match(/^\/share\/(?:(p|reels?)\/)?([A-Za-z0-9_-]{5,60})\/?$/);
    if (share) {
      return { platform: "instagram", id: share[2], short: true, canonical: `https://www.instagram.com/share/${share[1] ? `${share[1]}/` : ""}${share[2]}/` };
    }
    const code = instagramPostCode(url.pathname);
    if (!code) return null;
    const n = Number(url.searchParams.get("img_index"));
    const index = Number.isInteger(n) && n >= 1 && n <= 20 ? n : undefined;
    return {
      platform: "instagram",
      id: code,
      canonical: `https://www.instagram.com/p/${code}/${index ? `?img_index=${index}` : ""}`,
      ...(index ? { index } : {}),
    };
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

/**
 * The shortcode in an Instagram post's path: /p/, /reel/, /reels/ or /tv/,
 * after an optional username. Not "share" (the app's short links) and not
 * /reels/audio/ (a sound's page).
 */
export function instagramPostCode(pathname: string): string | null {
  return pathname.match(/^\/(?!share\/)(?:[\w.]{1,30}\/)?(?:p|reels?|tv)\/(?!audio\/)([A-Za-z0-9_-]{5,60})\/?/)?.[1] ?? null;
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
  tiktok: "TikTok",
  instagram: "Instagram",
};

/** What a downloader asks for when the box holds something else. */
export const PLATFORM_ASK: Record<MediaPlatform, string> = {
  youtube: "Paste a YouTube video link.",
  x: "Paste an X (Twitter) post link.",
  tiktok: "Paste a TikTok video link.",
  instagram: "Paste an Instagram Reel or post link.",
};

/**
 * Why a link the downloaders can't take was turned away, when there's more
 * to say than "paste a video link": a story, a profile or channel, a photo
 * post, a sound's page, a live broadcast. Null for anything else.
 */
export function mediaLinkProblem(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim().replace(/^(?!https?:\/\/)/i, "https://"));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const path = url.pathname;
  if (host === "instagram.com") {
    if (/^\/stories\//.test(path)) return "Stories can't be saved. Paste a Reel or post link.";
    if (/^\/reels?\/audio\//.test(path)) return "That's a sound's page. Paste a Reel or post link.";
    if (/^\/(?!(?:reels?|explore|accounts|direct)\/?$)[\w.]{1,30}\/?$/.test(path)) return "That's a profile. Paste a Reel or post link.";
  }
  if (host === "tiktok.com") {
    if (/^\/@[\w.-]+\/photo\/\d+/.test(path)) return "That's a photo post, so it has no video.";
    if (/^\/@[\w.-]+\/live\/?$/.test(path)) return "Live videos can't be saved.";
    if (/^\/music\//.test(path)) return "That's a sound's page. Paste one video's link.";
    if (/^\/@[\w.-]+\/?$/.test(path)) return "That's a profile. Paste one video's link.";
  }
  if (host === "x.com" || host === "twitter.com") {
    if (/^\/i\/(?:broadcasts|spaces)\//.test(path)) return "Live broadcasts and Spaces can't be saved.";
    if (/^\/(?!(?:home|explore|search|notifications|messages|settings|compose|i)\/?$)\w{1,15}\/?$/.test(path)) return "That's a profile. Paste one post's link.";
  }
  if (host === "youtube.com" && /^\/(?:@[^/]+|channel\/|c\/|user\/)/.test(path) && !url.searchParams.has("v")) {
    return "That's a channel. Paste one video's link.";
  }
  return null;
}

/** What to type in the link box, per platform. */
export const PLATFORM_PLACEHOLDER: Record<MediaPlatform, string> = {
  youtube: "youtu.be/…",
  x: "x.com/user/status/…",
  tiktok: "tiktok.com/@user/video/…",
  instagram: "instagram.com/reel/…",
};
