/**
 * Playlist export (CSV and plain links) and small formatting helpers for the
 * playlist downloader. Pure, so they can be unit tested.
 */

export interface PlaylistEntry {
  id: string;
  title: string;
  duration: number | null;
  thumbnail: string;
  url: string;
}

/** 3:07, or 1:02:03 for an hour or more. */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds < 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}

/** H:MM:SS, which spreadsheets read as a duration (m:ss alone reads as h:mm). */
function sheetDuration(seconds: number | null): string {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Quotes a CSV field. A leading = + - @ (or tab/CR) would make a spreadsheet
 * run the title as a formula, so such values are prefixed with an apostrophe.
 */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** UTF-8 CSV with a byte-order mark, so Excel shows non-Latin titles correctly. */
export function playlistCsv(entries: PlaylistEntry[]): string {
  const rows = entries.map((e) => [csvField(e.title), csvField(e.url), csvField(sheetDuration(e.duration))].join(","));
  return "﻿" + ["title,url,duration", ...rows].join("\r\n") + "\r\n";
}

export function playlistTxt(entries: PlaylistEntry[]): string {
  return entries.map((e) => e.url).join("\n") + "\n";
}

/** A safe file name from a playlist title. */
export function exportName(title: string, ext: string): string {
  const base = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/^\.+/, "");
  return `${base || "playlist"}.${ext}`;
}
