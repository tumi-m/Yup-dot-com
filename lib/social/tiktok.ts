/**
 * Resolve the video files behind a public TikTok post, without logging in
 * and without the media worker.
 *
 * Follows yt-dlp's web method (public domain): load the post page, read the
 * __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON, and take the play URLs. When
 * TikTok answers with its proof-of-work page instead, solve it (find the
 * number whose SHA-256 with the given prefix matches), set the cookie it asks
 * for, and load the page again. The video CDN wants the cookies and Referer
 * from that page, so they travel with the download grant.
 */
import { createHash } from "node:crypto";
import { cleanTitle } from "../media";
import type { XVariant } from "../x-video";
import { DirectResolveError, type DirectVideo, type Fetcher } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PAGE_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Hosts TikTok serves video from. www.tiktok.com play links are broken (yt-dlp #11034). */
const CDN_SUFFIXES = [".tiktokcdn.com", ".tiktokcdn-us.com", ".tiktokcdn-eu.com", ".tiktokv.com", ".tiktokv.us", ".tiktokv.eu", ".tiktok.com"];

export function isAllowedTikTokUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    if (["www.tiktok.com", "tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"].includes(host)) return false;
    return CDN_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

/** Short links (vm.tiktok.com/CODE, vt.tiktok.com/CODE, tiktok.com/t/CODE). */
export function isTikTokShortUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      (((u.hostname === "vm.tiktok.com" || u.hostname === "vt.tiktok.com") && /^\/\w{4,20}\/?$/.test(u.pathname)) ||
        (u.hostname === "www.tiktok.com" && /^\/t\/\w{4,20}\/?$/.test(u.pathname)))
    );
  } catch {
    return false;
  }
}

/** www.tiktok.com/@user/video/ID → { user, id } */
export function tiktokIdsFrom(raw: string): { user: string | null; id: string } | null {
  try {
    const u = new URL(raw);
    if (!/^(www\.|m\.)?tiktok\.com$/.test(u.hostname)) return null;
    const m =
      u.pathname.match(/^\/@([\w.-]{1,40})\/video\/(\d{8,25})/) ??
      u.pathname.match(/^\/(?:embed(?:\/v2)?|share\/video)\/(\d{8,25})/);
    if (!m) return null;
    return m.length === 3 ? { user: m[1], id: m[2] } : { user: null, id: m[1] };
  } catch {
    return null;
  }
}

type Json = Record<string, any>;

class CookieJar {
  private jar = new Map<string, string>();
  take(res: Response) {
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  set(name: string, value: string) {
    this.jar.set(name, value);
  }
  delete(name: string) {
    this.jar.delete(name);
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** The JSON inside <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">, at __DEFAULT_SCOPE__. */
export function universalData(html: string): Json | null {
  const m = html.match(/<script[^>]+\bid="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const scope = JSON.parse(m[1])?.__DEFAULT_SCOPE__;
    return scope && typeof scope === "object" ? scope : null;
  } catch {
    return null;
  }
}

function classOf(html: string, id: string): string | null {
  const tag = html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0];
  return tag?.match(/\bclass="([^"]*)"/)?.[1] ?? null;
}

/**
 * TikTok's proof-of-work: find i (≤ 1,000,000) where sha256(a + i) equals c.
 * Returns the cookies to set, or null if the page isn't a challenge.
 */
export function solveChallenge(html: string): { name: string; value: string; extra?: [string, string] } | null {
  const cs = classOf(html, "cs");
  const cookieName = classOf(html, "wci");
  if (!cs || !cookieName) return null;
  let data: Json;
  try {
    data = JSON.parse(Buffer.from(`${cs}===`, "base64").toString("utf8"));
  } catch {
    return null;
  }
  const a = typeof data?.v?.a === "string" ? Buffer.from(data.v.a, "base64") : null;
  const c = typeof data?.v?.c === "string" ? Buffer.from(data.v.c, "base64") : null;
  if (!a || !c) return null;
  const base = createHash("sha256").update(a);
  for (let i = 0; i <= 1_000_000; i++) {
    const digest = base.copy().update(String(i)).digest();
    if (digest.equals(c)) {
      data.d = Buffer.from(String(i)).toString("base64");
      const value = Buffer.from(JSON.stringify(data)).toString("base64");
      const rciName = classOf(html, "rci");
      const rciValue = classOf(html, "rs");
      return { name: cookieName, value, ...(rciName && rciValue ? { extra: [rciName, rciValue] as [string, string] } : {}) };
    }
  }
  return null;
}

/** "v12044gd0000…_h264_720p_1234567" → { codec, res: 720, bitrate } */
function parseUrlKey(key: string): { codec: string; res: number; bitrate: number } | null {
  const m = key.match(/v[^_]+_(([^_]+)_(\d+)p_(\d+))/);
  return m ? { codec: m[2], res: Number(m[3]) === 540 ? 576 : Number(m[3]), bitrate: Number(m[4]) } : null;
}

/** Turns a webapp.video-detail itemStruct into variants, best first. */
export function parseTikTokItem(id: string, item: Json, pageUrl: string, cookie: string): DirectVideo {
  const video: Json = item.video ?? {};
  const playW = Number(video.width) || null;
  const playH = Number(video.height) || null;
  const ratio = playW && playH ? playW / playH : 0.5625;
  const variants: XVariant[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown, v: Omit<XVariant, "url">) => {
    if (typeof raw !== "string") return;
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    if (!isAllowedTikTokUrl(url) || seen.has(url)) return;
    seen.add(url);
    variants.push({ url, ...v });
  };

  for (const info of Array.isArray(video.bitrateInfo) ? video.bitrateInfo : []) {
    const key = parseUrlKey(String(info?.PlayAddr?.UrlKey ?? ""));
    // bytevc2 is ByteDance's own codec, which nothing outside TikTok plays.
    if (key?.codec === "bytevc2") continue;
    let width: number | null = null;
    let height: number | null = null;
    if (key?.res) {
      if (ratio < 1) {
        width = key.res;
        height = Math.round(key.res / ratio / 2) * 2;
      } else {
        height = key.res;
        width = Math.round((key.res * ratio) / 2) * 2;
      }
    }
    const urls = Array.isArray(info?.PlayAddr?.UrlList) ? info.PlayAddr.UrlList : [];
    // Prefer H.264 (plays everywhere) over HEVC at the same size.
    const bitrate = (Number(info?.Bitrate) || key?.bitrate || 0) + (key?.codec === "h264" ? 1 : 0);
    for (const u of urls) {
      if (/\/media-video-hvc1\//.test(String(u))) continue; // sometimes video-only
      add(u, { bitrate, width, height });
    }
  }
  const play = Array.isArray(video.playAddr) ? video.playAddr.map((p: Json) => p?.src) : [video.playAddr];
  for (const u of play) add(u, { bitrate: 0, width: playW, height: playH });
  // The "download" address is watermarked: only if nothing else exists.
  if (!variants.length) add(video.downloadAddr ?? video.download?.url, { bitrate: 0, width: playW, height: playH });

  if (!variants.length) {
    throw new DirectResolveError(item.imagePost ? "no-video" : "unavailable");
  }
  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate);

  const author = typeof item.author === "object" ? item.author?.uniqueId : item.author;
  const cover = [video.cover, video.originCover, video.dynamicCover].find((u) => typeof u === "string") ?? null;
  return {
    platform: "tiktok",
    id,
    index: null,
    title: cleanTitle(item.desc)?.slice(0, 120) || (author ? `Video by @${author}` : "TikTok video"),
    author: typeof author === "string" ? author : null,
    thumbnail: cover,
    duration: Number(video.duration) || null,
    hasAudio: true,
    variants,
    fetchHeaders: { Referer: pageUrl, "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) },
  };
}

async function getPage(url: string, jar: CookieJar, fetcher: Fetcher): Promise<{ html: string; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetcher(current, {
      headers: { ...PAGE_HEADERS, ...(jar.header() ? { Cookie: jar.header() } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    jar.take(res);
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (location) {
      await res.body?.cancel();
      const next = new URL(location, current);
      if (next.pathname.startsWith("/login")) throw new DirectResolveError("login-required");
      if (!/^(www\.)?tiktok\.com$/.test(next.hostname)) throw new DirectResolveError("unreachable");
      current = next.toString();
      continue;
    }
    if (res.status === 404) throw new DirectResolveError("not-found");
    if (res.status === 403 || res.status === 429) throw new DirectResolveError("blocked");
    if (!res.ok) throw new DirectResolveError("unreachable");
    return { html: await res.text(), finalUrl: current };
  }
  throw new DirectResolveError("unreachable");
}

/** Follows a vm/vt/t short link to the post, checking every hop stays on TikTok. */
export async function expandTikTokShortUrl(short: string, fetcher: Fetcher = fetch): Promise<{ user: string | null; id: string }> {
  let current = short;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetcher(current, {
      method: "HEAD",
      // TikTok sends crawlers straight to the canonical post.
      headers: { "User-Agent": "facebookexternalhit/1.1" },
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    const next = new URL(location, current);
    if (!/(^|\.)tiktok\.com$/.test(next.hostname)) throw new DirectResolveError("not-found");
    const ids = tiktokIdsFrom(next.toString());
    if (ids) return ids;
    current = next.toString();
  }
  throw new DirectResolveError("not-found");
}

export async function resolveTikTok(
  ref: { id: string; user?: string | null; short?: string | null },
  fetcher: Fetcher = fetch
): Promise<DirectVideo> {
  let { id, user } = ref;
  try {
    if (ref.short) ({ id, user } = await expandTikTokShortUrl(ref.short, fetcher));
    if (!/^\d{8,25}$/.test(id)) throw new DirectResolveError("not-found");
    const pageUrl = `https://www.tiktok.com/@${user || "_"}/video/${id}`;
    const jar = new CookieJar();
    let { html } = await getPage(pageUrl, jar, fetcher);
    let data = universalData(html);
    if (!data) {
      const solved = solveChallenge(html);
      if (!solved) throw new DirectResolveError("blocked");
      jar.set(solved.name, solved.value);
      if (solved.extra) jar.set(solved.extra[0], solved.extra[1]);
      ({ html } = await getPage(pageUrl, jar, fetcher));
      // The challenge cookies are single-use.
      jar.delete(solved.name);
      if (solved.extra) jar.delete(solved.extra[0]);
      data = universalData(html);
      if (!data) throw new DirectResolveError("blocked");
    }
    const detail = data["webapp.video-detail"] ?? {};
    const status = Number(detail.statusCode) || 0;
    if (status === 10216 || status === 10222) throw new DirectResolveError("login-required");
    if (status === 10204) throw new DirectResolveError("blocked");
    const item = detail.itemInfo?.itemStruct;
    if (status !== 0 || !item || typeof item !== "object") throw new DirectResolveError("not-found");
    if (!item.video && item.isContentClassified) throw new DirectResolveError("login-required");
    return parseTikTokItem(id, item, pageUrl, jar.header());
  } catch (err) {
    if (err instanceof DirectResolveError) throw err;
    throw new DirectResolveError("unreachable");
  }
}
