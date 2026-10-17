/**
 * Resolve the video behind a public Instagram post or Reel, without logging
 * in and without the media worker.
 *
 * Follows yt-dlp's logged-out method (public domain), in order:
 *   1. Load instagram.com once for the "lsd" token and cookies, then ask the
 *      logged-out GraphQL query (PolarisLoggedOutDesktopWWWPostRootContentQuery)
 *      for the media by its numeric id.
 *   2. Load the post page and find the same media object in its embedded JSON.
 *   3. Load the post's embed page and read video_url from it.
 * Instagram limits logged-out access hard, especially from cloud servers, so
 * every step can come back empty; the visitor then gets a clear message.
 */
import { cleanTitle } from "../media";
import type { XVariant } from "../x-video";
import { DirectResolveError, type DirectVideo, type Fetcher } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP_ID = "936619743392459";
const DOC_ID = "27130156389949648";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const SHORTCODE = /^[A-Za-z0-9_-]{5,60}$/;

/** Shortcode → numeric media id (base-64 with Instagram's alphabet). */
export function shortcodeToPk(shortcode: string): string {
  // Private-post shortcodes carry 28 extra characters.
  const code = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
  let n = BigInt(0);
  for (const ch of code) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new DirectResolveError("not-found");
    n = n * BigInt(64) + BigInt(v);
  }
  return n.toString();
}

export function isAllowedInstagramUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    return host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net");
  } catch {
    return false;
  }
}

type Json = Record<string, any>;

function cookiesFrom(res: Response, jar: Map<string, string>) {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

/** Instagram redirects logged-out visitors it won't serve to the login page or home. */
function isLoginRedirect(res: Response): boolean {
  const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
  if (!location) return false;
  try {
    const path = new URL(location, "https://www.instagram.com").pathname;
    return path.startsWith("/accounts/login") || path === "/";
  } catch {
    return false;
  }
}

/** The lsd token from the home page (inside __eqmc, or the LSD config). */
export function lsdToken(html: string): string | null {
  const eqmc = html.match(/<script\b[^>]*\bid="__eqmc"[^>]*>([\s\S]*?)<\/script>/);
  if (eqmc) {
    try {
      const l = JSON.parse(eqmc[1])?.l;
      if (typeof l === "string") return l;
    } catch {}
  }
  return html.match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1] ?? null;
}

/** Depth-first search for the first object with `key` (handles Instagram's nested page JSON). */
function findKey(node: unknown, key: string, depth = 0): Json | null {
  if (!node || typeof node !== "object" || depth > 40) return null;
  if (!Array.isArray(node) && key in (node as Json)) return (node as Json)[key];
  for (const v of Array.isArray(node) ? node : Object.values(node as Json)) {
    const found = findKey(v, key, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Turns a media object (or a carousel) into a DirectVideo. `index` picks the n-th slide (1-based). */
export function parseInstagramMedia(shortcode: string, product: Json, index?: number | null): DirectVideo {
  const slides: Json[] = Array.isArray(product.carousel_media) ? product.carousel_media : [product];
  const videos = slides.filter((m) => Array.isArray(m?.video_versions) && m.video_versions.length);
  if (!videos.length) throw new DirectResolveError("no-video");
  const wanted = index && slides[index - 1] && videos.includes(slides[index - 1]) ? slides[index - 1] : videos[0];

  const variants: XVariant[] = [];
  const seen = new Set<string>();
  for (const v of wanted.video_versions as Json[]) {
    if (typeof v?.url !== "string" || !isAllowedInstagramUrl(v.url) || seen.has(v.url)) continue;
    seen.add(v.url);
    variants.push({ url: v.url, bitrate: Number(v.bandwidth) || 0, width: Number(v.width) || null, height: Number(v.height) || null });
  }
  if (!variants.length) throw new DirectResolveError("unavailable");
  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate);

  const username = product.user?.username ?? product.owner?.username ?? null;
  const caption = product.caption?.text ?? product.edge_media_to_caption?.edges?.[0]?.node?.text;
  const thumbs: Json[] = wanted.image_versions2?.candidates ?? product.image_versions2?.candidates ?? [];
  return {
    platform: "instagram",
    id: shortcode,
    index: videos.length > 1 ? videos.indexOf(wanted) + 1 : null,
    title: cleanTitle(caption)?.slice(0, 120) || (username ? `Video by @${username}` : "Instagram video"),
    author: typeof username === "string" ? username : null,
    thumbnail: typeof thumbs[0]?.url === "string" ? thumbs[0].url : null,
    duration: Number(wanted.video_duration) || null,
    hasAudio: wanted.has_audio !== false,
    variants,
    fetchHeaders: { Referer: "https://www.instagram.com/", "User-Agent": UA },
  };
}

/** Older-style media (page JSON / embed): video_url + dimensions. */
function legacyMedia(node: Json): Json | null {
  if (typeof node?.video_url !== "string") return null;
  return {
    video_versions: [{ url: node.video_url, width: node.dimensions?.width, height: node.dimensions?.height }],
    has_audio: node.has_audio,
    video_duration: node.video_duration,
    owner: node.owner,
    edge_media_to_caption: node.edge_media_to_caption,
    image_versions2: node.display_url ? { candidates: [{ url: node.display_url }] } : undefined,
  };
}

async function get(fetcher: Fetcher, url: string, jar: Map<string, string>, headers: Record<string, string> = {}) {
  const res = await fetcher(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...headers, ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  cookiesFrom(res, jar);
  return res;
}

export async function resolveInstagram(shortcode: string, fetcher: Fetcher = fetch, index?: number | null): Promise<DirectVideo> {
  if (!SHORTCODE.test(shortcode)) throw new DirectResolveError("not-found");
  const pk = shortcodeToPk(shortcode);
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  const jar = new Map<string, string>();
  let sawLoginWall = false;
  let definitive: DirectResolveError | null = null;

  const attempt = async <T>(fn: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof DirectResolveError && err.kind !== "unreachable") definitive ??= err;
      return null;
    }
  };

  // 1. Logged-out GraphQL.
  const viaGraphql = await attempt(async () => {
    const home = await get(fetcher, "https://www.instagram.com/", jar, { Accept: "text/html" });
    if (!home.ok) return null;
    const lsd = lsdToken(await home.text());
    if (!lsd) return null;
    const body = new URLSearchParams({
      lsd,
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "PolarisLoggedOutDesktopWWWPostRootContentQuery",
      server_timestamps: "true",
      variables: JSON.stringify({ media_id: pk }),
      doc_id: DOC_ID,
    });
    const gql = await fetcher("https://www.instagram.com/api/graphql", {
      method: "POST",
      body,
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "*/*",
        Origin: "https://www.instagram.com",
        Referer: postUrl,
        "X-IG-App-ID": APP_ID,
        "X-ASBD-ID": "359341",
        "X-IG-WWW-Claim": "0",
        "X-FB-Friendly-Name": "PolarisLoggedOutDesktopWWWPostRootContentQuery",
        "X-FB-LSD": lsd,
        "X-Requested-With": "XMLHttpRequest",
        ...(jar.get("csrftoken") ? { "X-CSRFToken": jar.get("csrftoken")! } : {}),
        ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (isLoginRedirect(gql)) {
      sawLoginWall = true;
      return null;
    }
    if (!gql.ok) return null;
    const json = (await gql.json().catch(() => null)) as Json | null;
    const product = json?.data?.xig_polaris_media?.if_not_gated_logged_out;
    if (!product) return null;
    return parseInstagramMedia(shortcode, product, index);
  });
  if (viaGraphql) return viaGraphql;

  // 2. The post page's embedded JSON.
  const viaPage = await attempt(async () => {
    const res = await get(fetcher, postUrl, jar, { Accept: "text/html" });
    if (isLoginRedirect(res)) {
      sawLoginWall = true;
      return null;
    }
    if (res.status === 404) throw new DirectResolveError("not-found");
    if (!res.ok) return null;
    const html = await res.text();
    for (const m of html.matchAll(/<script\b[^>]*\bdata-sjs[^>]*>(\{[\s\S]+?\})<\/script>/g)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const media = findKey(parsed, "xig_polaris_media");
      const product = media?.if_not_gated_logged_out;
      if (product) return parseInstagramMedia(shortcode, product, index);
    }
    return null;
  });
  if (viaPage) return viaPage;

  // 3. The embed page.
  const viaEmbed = await attempt(async () => {
    const res = await get(fetcher, `https://www.instagram.com/p/${shortcode}/embed/captioned/`, jar, { Accept: "text/html" });
    if (!res.ok) return null;
    const html = await res.text();
    const raw = html.match(/"video_url":"((?:[^"\\]|\\.)+)"/)?.[1];
    if (raw) {
      const url = JSON.parse(`"${raw}"`) as string;
      const owner = html.match(/"username":"([\w.]{1,30})"/)?.[1];
      const media = legacyMedia({ video_url: url, owner: owner ? { username: owner } : undefined });
      if (media) return parseInstagramMedia(shortcode, media, index);
    }
    // A photo-only post's embed has no video.
    if (/class="EmbeddedMediaImage"/.test(html) && !/video/i.test(html)) throw new DirectResolveError("no-video");
    return null;
  });
  if (viaEmbed) return viaEmbed;

  if (definitive) throw definitive;
  throw new DirectResolveError(sawLoginWall ? "blocked" : "unreachable");
}
