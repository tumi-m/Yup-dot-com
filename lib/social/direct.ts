/**
 * Platforms the web app downloads from by itself (no media worker): X,
 * TikTok and Instagram. One place for resolving a post, checking which hosts
 * a download may come from, naming files and wording failures.
 */
import type { ParsedMediaUrl } from "../media";
import { isAllowedVideoUrl, resolveXVideo, XResolveError, xFilename } from "../x-video";
import { isAllowedInstagramUrl, resolveInstagram } from "./instagram";
import { isAllowedTikTokUrl, resolveTikTok } from "./tiktok";
import { DirectResolveError, type DirectFailure, type DirectPlatform, type DirectVideo, type Fetcher } from "./types";

export { DirectResolveError } from "./types";
export type { DirectPlatform, DirectVideo } from "./types";

export const DIRECT_PLATFORMS: readonly DirectPlatform[] = ["x", "tiktok", "instagram"];

export function isDirectPlatform(p: string): p is DirectPlatform {
  return (DIRECT_PLATFORMS as readonly string[]).includes(p);
}

const NAME: Record<DirectPlatform, string> = { x: "X", tiktok: "TikTok", instagram: "Instagram" };

export function failureMessage(platform: DirectPlatform, kind: DirectFailure): string {
  const name = NAME[platform];
  const what = platform === "x" ? "post" : platform === "tiktok" ? "video" : "post";
  switch (kind) {
    case "not-found":
      return `That ${what} doesn't exist, or the link is wrong.`;
    case "unavailable":
      return `That ${what} was deleted or is restricted.`;
    case "no-video":
      return `That ${what} doesn't contain a video.`;
    case "login-required":
      return `That ${what} is private or needs a ${name} login, so it can't be downloaded.`;
    case "blocked":
      return `${name} is limiting downloads right now. Try again in a few minutes.`;
    default:
      return `${name} isn't responding right now. Try again in a minute.`;
  }
}

/** Resolves a parsed link on one of the direct platforms. Throws DirectResolveError. */
export async function resolveDirect(media: ParsedMediaUrl, fetcher: Fetcher = fetch): Promise<DirectVideo> {
  switch (media.platform) {
    case "x":
      try {
        return { ...(await resolveXVideo(media.id, fetcher, media.index)), platform: "x" };
      } catch (err) {
        throw new DirectResolveError(err instanceof XResolveError ? err.kind : "unreachable");
      }
    case "tiktok":
      return resolveTikTok({ id: media.id, user: media.user ?? null, short: media.short ? media.canonical : null }, fetcher);
    case "instagram":
      return resolveInstagram(media.id, fetcher, media.index);
    default:
      throw new DirectResolveError("not-found");
  }
}

/** Where a download for this platform may be fetched from (anything else is refused). */
export function isAllowedMediaUrl(url: string, platform: DirectPlatform): boolean {
  if (platform === "x") return isAllowedVideoUrl(url);
  if (platform === "tiktok") return isAllowedTikTokUrl(url);
  if (platform === "instagram") return isAllowedInstagramUrl(url);
  return false;
}

/** Only these headers may travel in a grant to the video CDN. */
export function grantHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h || typeof h !== "object") return out;
  for (const key of ["Cookie", "Referer", "User-Agent"]) {
    const v = (h as Record<string, unknown>)[key];
    // No line breaks: a header value can't smuggle another header.
    if (typeof v === "string" && v.length <= 2000 && !/[\r\n]/.test(v)) out[key] = v;
  }
  return out;
}

export function directFilename(video: DirectVideo, ext: "mp4" | "mp3", height?: number | null): string {
  if (video.platform === "x") return xFilename(video, ext, height);
  const post = video.index ? `${video.id}-${video.index}` : video.id;
  const base = `${video.platform}-${video.author ? `${video.author}-` : ""}${post}`.replace(/[^\w.-]+/g, "_");
  return `${base}${ext === "mp4" && height ? `-${height}p` : ""}.${ext}`;
}
