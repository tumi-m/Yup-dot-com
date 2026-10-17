import type { XVideo } from "../x-video";

export type DirectPlatform = "x" | "tiktok" | "instagram";

/** A post's video, resolved by the web app itself (no media worker). */
export interface DirectVideo extends XVideo {
  platform: DirectPlatform;
  /**
   * Headers the video CDN needs (cookies from the post page, Referer). They
   * travel inside the signed download grant to /api/media/file.
   */
  fetchHeaders?: Record<string, string>;
}

export type DirectFailure = "not-found" | "unavailable" | "no-video" | "login-required" | "unreachable" | "blocked";

export class DirectResolveError extends Error {
  constructor(public readonly kind: DirectFailure) {
    super(kind);
  }
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
