/**
 * Resolve the video behind a public Instagram post or Reel, without logging
 * in and without the media worker.
 *
 * What works from a cloud server (checked against instagram.com, November
 * 2026): Instagram answers page requests that lack a browser's Sec-Fetch
 * headers with its error page (HTTP 200, PolarisErrorRoute) and API requests
 * with "SecFetch Policy violation", so every request here sends the headers a
 * browser sends. With them, in order:
 *   1. The post page carries the media (xig_polaris_media) in its embedded
 *      JSON, the same object yt-dlp reads. Works for public posts.
 *   2. The embed page carries it as escaped JSON (contextJSON), with
 *      video_url, except for posts whose music is blocked from embeds. A
 *      deleted post's embed is a "broken media" card, so this step also tells
 *      a gone post from a refusal.
 *   3. yt-dlp's logged-out GraphQL query, after get_ruling_for_content (which
 *      sets the csrf cookie). Instagram answers it with HTTP 429 to plain
 *      HTTP clients (yt-dlp only sends it while impersonating a browser's
 *      TLS), so it is the last resort.
 * What doesn't: Instagram can still refuse a server outright (login redirect,
 * 429, its error page for every route). The visitor is then told Instagram is
 * limiting downloads and to try again later; nothing else would get through.
 * Each failed resolve logs one line with every step's outcome.
 */
import { cleanTitle } from "../media";
import type { XVariant } from "../x-video";
import { DirectResolveError, type DirectVideo, type Fetcher } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const APP_ID = "936619743392459";
const DOC_ID = "27130156389949648";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** The whole resolve stays well inside the routes' 30-second limit. */
const BUDGET_MS = 20_000;
const REQUEST_MS = 8_000;

/** A browser opening the page from the address bar. */
const PAGE_HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};
/** instagram.com's own scripts calling its API. */
const API_HEADERS = {
  "User-Agent": UA,
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://www.instagram.com",
  "X-IG-App-ID": APP_ID,
  "X-ASBD-ID": "359341",
  "X-IG-WWW-Claim": "0",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

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

/** Why Instagram refused this answer, if it did: a login wall or a limit. */
function refusal(res: Response): string | null {
  if (isLoginRedirect(res)) return "login redirect";
  if (res.status === 429) return "rate limited";
  if (res.status === 401 || res.status === 403) return "refused";
  return null;
}

/** Instagram's rate-limit answers in JSON ("Please wait a few minutes…", require_login). */
function isLimitJson(json: Json | null): boolean {
  if (!json || typeof json !== "object") return false;
  const message = typeof json.message === "string" ? json.message : "";
  return json.require_login === true || /wait a few minutes|login_required/i.test(message);
}

/** The error page Instagram renders (HTTP 200) for a refused client or a gone post. */
const isErrorPage = (html: string) => html.includes('"canonicalRouteName":"comet.igweb.PolarisErrorRoute"');

/** The lsd token (inside __eqmc, or the LSD config); every page carries it. */
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

/** The post page's xig_polaris_media object, from its data-sjs JSON. */
export function pageMedia(html: string): Json | null {
  for (const m of html.matchAll(/<script\b[^>]*\bdata-sjs[^>]*>(\{[\s\S]+?\})<\/script>/g)) {
    if (!m[1].includes('"xig_polaris_media"')) continue;
    try {
      const media = findKey(JSON.parse(m[1]), "xig_polaris_media");
      if (media) return media;
    } catch {}
  }
  return null;
}

/** "PT0H0M4.967S" → 4.967 (the DASH manifest is where the page keeps the length). */
function dashSeconds(manifest: unknown): number | null {
  const m = typeof manifest === "string" ? manifest.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/) : null;
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) || null;
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
    // The page's video_versions carry no size; the media's own size applies.
    const width = Number(v.width) || Number(wanted.original_width) || null;
    const height = Number(v.height) || Number(wanted.original_height) || null;
    variants.push({ url: v.url, bitrate: Number(v.bandwidth) || 0, width, height });
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
    duration: Number(wanted.video_duration) || dashSeconds(wanted.video_dash_manifest),
    hasAudio: wanted.has_audio !== false,
    variants,
    fetchHeaders: { Referer: "https://www.instagram.com/", "User-Agent": UA },
  };
}

/** Older-style media (embed page): video_url + dimensions; a photo slide has no video_versions. */
function legacyMedia(node: Json): Json {
  return {
    video_versions: typeof node?.video_url === "string" ? [{ url: node.video_url, width: node.dimensions?.width, height: node.dimensions?.height }] : undefined,
    has_audio: node?.has_audio,
    video_duration: node?.video_duration,
    image_versions2: typeof node?.display_url === "string" ? { candidates: [{ url: node.display_url }] } : undefined,
  };
}

/**
 * The embed page's shortcode_media: escaped JSON in contextJSON (what
 * Instagram sends now), window.__additionalDataLoaded(...) (older pages), or
 * a bare "video_url" as a last resort.
 */
export function embedMedia(html: string): Json | null {
  const ctx = html.match(/"contextJSON":("(?:[^"\\]|\\.)*")/)?.[1];
  if (ctx) {
    try {
      const media = JSON.parse(JSON.parse(ctx))?.gql_data?.shortcode_media;
      if (media && typeof media === "object") return media;
    } catch {}
  }
  const extra = html.match(/__additionalDataLoaded\(\s*['"][^'"]*['"]\s*,\s*(\{[\s\S]*?\})\s*\)\s*;/)?.[1];
  if (extra) {
    try {
      const data = JSON.parse(extra);
      const media = data?.shortcode_media ?? data?.graphql?.shortcode_media;
      if (media && typeof media === "object") return media;
    } catch {}
  }
  const raw = html.match(/"video_url":"((?:[^"\\]|\\.)+)"/)?.[1];
  if (raw) {
    try {
      const owner = html.match(/"username":"([\w.]{1,30})"/)?.[1];
      return { is_video: true, video_url: JSON.parse(`"${raw}"`), owner: owner ? { username: owner } : undefined };
    } catch {}
  }
  return null;
}

/** shortcode_media → the media shape parseInstagramMedia reads (carousels included). */
function fromEmbed(media: Json): Json {
  const children: Json[] | undefined = media.edge_sidecar_to_children?.edges?.map((e: Json) => e?.node).filter(Boolean);
  return {
    ...(children?.length ? { carousel_media: children.map(legacyMedia) } : legacyMedia(media)),
    owner: media.owner,
    edge_media_to_caption: media.edge_media_to_caption,
  };
}

/** One step's outcome, for the log line. */
interface Step {
  step: string;
  status?: number;
  reason: string;
}

export async function resolveInstagram(shortcode: string, fetcher: Fetcher = fetch, index?: number | null): Promise<DirectVideo> {
  if (!SHORTCODE.test(shortcode)) throw new DirectResolveError("not-found");
  const pk = shortcodeToPk(shortcode);
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;
  const jar = new Map<string, string>();
  const deadline = Date.now() + BUDGET_MS;
  const steps: Step[] = [];
  // What the answers so far say: Instagram refused (login wall, limit, error
  // page); the post exists but is withheld logged out; or a final verdict.
  const seen: { refused: boolean; gated: boolean; definitive: DirectResolveError | null; lsd: string | null } = {
    refused: false,
    gated: false,
    definitive: null,
    lsd: null,
  };

  const request = async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const left = deadline - Date.now();
    if (left < 1_000) throw new Error("out of time");
    const res = await fetcher(url, {
      ...init,
      headers: { ...init.headers, ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(REQUEST_MS, left)),
      cache: "no-store",
    });
    cookiesFrom(res, jar);
    return res;
  };

  // Runs one step. `note` records its status and reason and returns null
  // (nothing found). A DirectResolveError other than unreachable is
  // Instagram's final word on the post.
  type Note = (status: number | undefined, reason: string, refused?: boolean) => null;
  const attempt = async (step: string, fn: (note: Note) => Promise<DirectVideo | null>) => {
    const out: Step = { step, reason: "" };
    const note: Note = (status, reason, refused = false) => {
      out.status = status ?? out.status;
      out.reason = reason;
      if (refused) seen.refused = true;
      return null;
    };
    try {
      return await fn(note);
    } catch (err) {
      if (err instanceof DirectResolveError) {
        if (err.kind !== "unreachable") seen.definitive ??= err;
        if (!out.reason || out.reason === "media") out.reason = err.kind;
      } else {
        const e = err as Error;
        out.reason = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : e?.message === "out of time" ? "out of time" : "network error";
      }
      return null;
    } finally {
      steps.push(out);
    }
  };

  // A page request's answer: refused, missing, or its HTML.
  const page = async (url: string, note: Note): Promise<string | null> => {
    const res = await request(url, { headers: PAGE_HEADERS });
    const why = refusal(res);
    if (why) return note(res.status, why, true);
    if (res.status === 404) {
      note(404, "not found");
      throw new DirectResolveError("not-found");
    }
    if (!res.ok) return note(res.status, "http error");
    const html = await res.text();
    seen.lsd ??= lsdToken(html);
    note(res.status, "");
    return html;
  };

  // 1. The post page's embedded JSON.
  const viaPage = await attempt("page", async (note) => {
    const html = await page(postUrl, note);
    if (html === null) return null;
    const media = pageMedia(html);
    if (media?.if_not_gated_logged_out) {
      note(undefined, "media");
      return parseInstagramMedia(shortcode, media.if_not_gated_logged_out, index);
    }
    if (media) {
      seen.gated = true;
      return note(undefined, "empty product");
    }
    if (isErrorPage(html)) {
      // Instagram's own flag for an age-restricted post.
      if (/"restricted_age":(?!null)/.test(html)) {
        note(undefined, "age restricted");
        throw new DirectResolveError("login-required");
      }
      return note(undefined, "error page", true);
    }
    return note(undefined, "no media json");
  });
  if (viaPage) return viaPage;

  // 2. The embed page. Also says whether the post is gone or photo-only.
  if (!seen.definitive) {
    const viaEmbed = await attempt("embed", async (note) => {
      const html = await page(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, note);
      if (html === null) return null;
      const media = embedMedia(html);
      if (media) {
        const product = fromEmbed(media);
        const slides: Json[] = product.carousel_media ?? [product];
        if (slides.some((s) => s.video_versions)) {
          note(undefined, "media");
          return parseInstagramMedia(shortcode, product, index);
        }
        // A video whose embed leaves the file out (music it can't show off
        // Instagram), alone or as a carousel slide: the API may still have it.
        const isVideo = (n: Json) => n?.is_video === true || n?.__typename === "GraphVideo";
        const children: Json[] = media.edge_sidecar_to_children?.edges?.map((e: Json) => e?.node) ?? [];
        if (isVideo(media) || children.some(isVideo)) return note(undefined, "no video in embed");
        note(undefined, "photo only");
        throw new DirectResolveError("no-video");
      }
      if (html.includes('class="EmbedBrokenMedia"')) {
        // A private post's embed is broken too; its long shortcode says which.
        note(undefined, "broken embed");
        throw new DirectResolveError(shortcode.length > 28 ? "login-required" : "not-found");
      }
      if (isErrorPage(html)) return note(undefined, "error page", true);
      return note(undefined, "no media in embed");
    });
    if (viaEmbed) return viaEmbed;
  }

  // 3. Logged-out GraphQL, after the ruling check that sets the csrf cookie.
  // It needs the lsd token from one of the pages above.
  const lsd = seen.lsd;
  if (!seen.definitive && !lsd) steps.push({ step: "graphql", reason: "no lsd" });
  if (!seen.definitive && lsd) {
    const viaGraphql = await attempt("graphql", async (note) => {
      const ruling = await request(
        `https://www.instagram.com/api/v1/web/get_ruling_for_content/?content_type=MEDIA&target_id=${pk}`,
        { headers: { ...API_HEADERS, Referer: postUrl } }
      );
      const why = refusal(ruling);
      const verdict = why ? null : ((await ruling.json().catch(() => null)) as Json | null);
      const limited = why ?? (isLimitJson(verdict) ? "rate limited" : null);
      steps.push({ step: "ruling", status: ruling.status, reason: limited ?? (verdict?.status === "ok" ? "ok" : "not ok") });
      // The query goes through the same limits: no point asking it.
      if (limited) return note(undefined, "skipped", true);
      if (/restricted/i.test(`${verdict?.title ?? ""} ${verdict?.description ?? ""}`)) {
        note(undefined, "restricted");
        throw new DirectResolveError("login-required");
      }
      // Like yt-dlp: the csrf token goes along only when the ruling is "ok".
      const csrf = verdict?.status === "ok" ? jar.get("csrftoken") : undefined;
      const gql = await request("https://www.instagram.com/api/graphql", {
        method: "POST",
        body: new URLSearchParams({
          lsd,
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: "PolarisLoggedOutDesktopWWWPostRootContentQuery",
          server_timestamps: "true",
          variables: JSON.stringify({ media_id: pk }),
          doc_id: DOC_ID,
        }),
        headers: {
          ...API_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: postUrl,
          "X-FB-Friendly-Name": "PolarisLoggedOutDesktopWWWPostRootContentQuery",
          "X-FB-LSD": lsd,
          "X-Requested-With": "XMLHttpRequest",
          ...(csrf ? { "X-CSRFToken": csrf } : {}),
        },
      });
      const gwhy = refusal(gql);
      if (gwhy) return note(gql.status, gwhy, true);
      if (!gql.ok) return note(gql.status, "http error");
      const json = (await gql.json().catch(() => null)) as Json | null;
      if (isLimitJson(json)) return note(gql.status, "rate limited", true);
      const product = json?.data?.xig_polaris_media?.if_not_gated_logged_out;
      if (!product) return note(gql.status, "empty product");
      note(gql.status, "media");
      return parseInstagramMedia(shortcode, product, index);
    });
    if (viaGraphql) return viaGraphql;
  }

  // A post withheld from logged-out visitors, or a private link (its long
  // shortcode), won't come through later either, whatever else refused us.
  const failure =
    seen.definitive ??
    new DirectResolveError(seen.gated || shortcode.length > 28 ? "login-required" : seen.refused ? "blocked" : "unreachable");
  // One line per failed resolve for the server logs: steps and statuses only.
  console.warn(`Instagram resolve failed (${failure.kind}): ${steps.map((s) => `${s.step}${s.status ? ` ${s.status}` : ""} ${s.reason}`).join("; ")}`);
  throw failure;
}
