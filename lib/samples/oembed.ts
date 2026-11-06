/**
 * A YouTube video's title, channel and thumbnail from YouTube's public
 * oEmbed endpoint: no API key, no download, one small request.
 */
import "server-only";
import { cleanTitle, isYoutubeId, youtubeWatchUrl } from "../media";
import type { Fetcher } from "./musicbrainz";

export interface OEmbedInfo {
  title: string;
  channel: string | null;
  thumbnail: string | null;
}

/** "private": removed, private or no such video. "blocked": its owner turned off embedding, so oEmbed can't read it. */
export type OEmbedFailure = "private" | "blocked" | "unreachable";

export class OEmbedError extends Error {
  constructor(public readonly kind: OEmbedFailure) {
    super(kind);
  }
}

export const OEMBED_MESSAGE: Record<OEmbedFailure, string> = {
  private: "That video is private or was removed.",
  blocked: "YouTube won't share this video's title. Type the song instead.",
  unreachable: "YouTube didn't answer. Try again, or type the song.",
};

/** Thumbnails come only from YouTube's image host, so a page never loads an image from anywhere else. */
function thumbnailUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /^i\d?\.ytimg\.com$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

export async function youtubeOEmbed(id: string, fetcher: Fetcher = fetch, timeoutMs = 5000): Promise<OEmbedInfo> {
  if (!isYoutubeId(id)) throw new OEmbedError("private");
  const url = `https://www.youtube.com/oembed?${new URLSearchParams({ url: youtubeWatchUrl(id), format: "json" })}`;
  let res: Response;
  try {
    res = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new OEmbedError("unreachable");
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    throw new OEmbedError("blocked");
  }
  if (res.status === 404 || res.status === 400) {
    await res.body?.cancel().catch(() => {});
    throw new OEmbedError("private");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new OEmbedError("unreachable");
  }
  let data: Record<string, unknown>;
  try {
    const text = await res.text();
    if (text.length > 100_000) throw new Error("too large");
    data = JSON.parse(text);
  } catch {
    throw new OEmbedError("unreachable");
  }
  const title = cleanTitle(data?.title).slice(0, 300);
  if (!title) throw new OEmbedError("unreachable");
  return {
    title,
    channel: cleanTitle(data?.author_name).slice(0, 120) || null,
    thumbnail: thumbnailUrl(data?.thumbnail_url),
  };
}
