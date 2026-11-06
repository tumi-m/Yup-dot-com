/**
 * Links the Sample Finder builds. Safe for the browser: no network.
 */
import { youtubeWatchUrl } from "../media";
import type { SongRef, Tab } from "./types";

export const SAMPLE_FINDER_PATH = "/tools/sample-finder";

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
