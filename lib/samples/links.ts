/**
 * Links the Sample Finder builds and reads. Safe for the browser: no network.
 */
import { youtubeWatchUrl } from "../media";
import type { SongRef, Tab } from "./types";

export const SAMPLE_FINDER_PATH = "/tools/sample-finder";

export const INPUT_HELP = "Paste a YouTube or TikTok link, or type Artist – Title.";
export const PLAYLIST_MESSAGE = "That's a playlist. Paste one song's link.";

/**
 * A TikTok photo post (tiktok.com/@user/photo/<id>). The downloaders have no
 * video to take from one, but its sound can still be read.
 */
export function tiktokPhotoLink(link: string): { id: string; user: string } | null {
  try {
    const u = new URL(link.trim().replace(/^(?!https?:\/\/)/i, "https://"));
    if (!/^(?:www\.|m\.)?tiktok\.com$/i.test(u.hostname)) return null;
    const m = /^\/@([\w.-]{1,40})\/photo\/(\d{8,25})\/?$/.exec(u.pathname);
    return m ? { user: m[1], id: m[2] } : null;
  } catch {
    return null;
  }
}

const STREAMING: [RegExp, string][] = [
  [/(^|\.)spotify\.com$|^spotify\.link$/, "Spotify"],
  [/^music\.apple\.com$/, "Apple Music"],
  [/(^|\.)soundcloud\.com$/, "SoundCloud"],
  [/(^|\.)deezer\.com$|^deezer\.page\.link$/, "Deezer"],
  [/(^|\.)tidal\.com$/, "Tidal"],
];

/**
 * Why a link the Sample Finder can't read was turned away, when there's
 * something more useful to say than the general help: a streaming service's
 * link, or a YouTube channel or TikTok profile rather than one video. Null
 * for anything else, words included.
 */
export function linkProblem(text: string): string | null {
  if (/\s/.test(text.trim())) return null;
  let url: URL;
  try {
    url = new URL(text.trim().replace(/^(?!https?:\/\/)/i, "https://"));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  for (const [re, name] of STREAMING) if (re.test(host)) return `${name} links can't be read. Type Artist – Title.`;
  if (/^(?:www\.|m\.|music\.)?youtube\.com$/.test(host) && /^\/(?:@[^/]+|channel\/|c\/|user\/)/.test(url.pathname) && !url.searchParams.has("v")) {
    return "That's a channel. Paste one video's link.";
  }
  if (/^(?:www\.|m\.)?tiktok\.com$/.test(host) && /^\/@[\w.-]+\/?$/.test(url.pathname)) return "That's a profile. Paste one video's link.";
  return null;
}

/**
 * The song in a shared link's ?q= ("Artist – Title"), split on the dash
 * only: the title keeps any "(… remix)" or "(Live)", which names that version.
 */
export function splitSongQuery(q: string): { artist: string; title: string } {
  const text = q.replace(/\s+/g, " ").trim();
  for (const sep of [" – ", " — ", " - "]) {
    const at = text.indexOf(sep);
    if (at > 0 && at + sep.length < text.length) return { artist: text.slice(0, at).trim(), title: text.slice(at + sep.length).trim() };
  }
  return { artist: "", title: text };
}

/** A YouTube search for the song: never a guessed video id. */
export function youtubeSearchUrl(artist: string, title: string): string {
  const q = `${artist} ${title}`.replace(/\s+/g, " ").trim();
  return `https://www.youtube.com/results?${new URLSearchParams({ search_query: q })}`;
}

export function watchUrl(id: string): string {
  return youtubeWatchUrl(id);
}

/** How the box and share links write a song: "Artist – Title". */
export function songQuery(song: Pick<SongRef, "artist" | "title">): string {
  return song.artist ? `${song.artist} – ${song.title}` : song.title;
}

/**
 * The address a result can be shared at: the song in words and its
 * MusicBrainz id, never the video link it was found from.
 */
export function shareHref(song: Pick<SongRef, "artist" | "title" | "mbid">, tab?: Tab | null): string {
  const params = new URLSearchParams({ q: songQuery(song) });
  if (song.mbid) params.set("rec", song.mbid);
  if (tab && tab !== "samples") params.set("tab", tab);
  return `${SAMPLE_FINDER_PATH}?${params}`;
}

/** The Sample Finder opened with a video link in its box. */
export function finderForLink(url: string): string {
  return `${SAMPLE_FINDER_PATH}?${new URLSearchParams({ url })}`;
}

export function musicBrainzRecordingUrl(mbid: string): string {
  return `https://musicbrainz.org/recording/${encodeURIComponent(mbid)}`;
}
