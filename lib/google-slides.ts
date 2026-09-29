/**
 * Import a Google Slides deck by its share link, as PDF or PPTX.
 *
 * Uses Google's public export endpoint
 * (docs.google.com/presentation/d/<id>/export/<format>), which works for any
 * deck shared as "Anyone with the link". Redirects are followed by hand and
 * only to Google's own hosts, so a link can never make the server fetch an
 * arbitrary address.
 */
import { z } from "zod";
import { limitsFor, type Tier } from "./limits";

export type SlidesFormat = "pdf" | "pptx";

export const SLIDES_MIME: Record<SlidesFormat, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export type SlidesFailure = "invalid" | "published" | "private" | "not-found" | "rate-limited" | "unreachable";

export const SLIDES_FAILURE_MESSAGE: Record<SlidesFailure, string> = {
  invalid: "Paste a Google Slides link.",
  published: "That's a published-to-web link. Use the deck's Share link instead.",
  private: "This deck is private. In Google Slides choose Share → Anyone with the link, then try again.",
  "not-found": "That deck doesn't exist, or the link is wrong.",
  "rate-limited": "Google is busy. Try again in a few minutes.",
  unreachable: "Google Slides isn't responding. Try again in a minute.",
};

export const SLIDES_FAILURE_STATUS: Record<SlidesFailure, number> = {
  invalid: 400,
  published: 400,
  private: 403,
  "not-found": 404,
  "rate-limited": 429,
  unreachable: 502,
};

export class SlidesError extends Error {
  constructor(public readonly kind: SlidesFailure) {
    super(kind);
  }
}

const ID_RE = /^[A-Za-z0-9_-]{10,128}$/;

function toUrl(input: string): URL | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

/** Path segments after /presentation, without an optional /u/<n> prefix. */
function presentationPath(input: string): string[] | null {
  const u = toUrl(input);
  if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  if (u.hostname.toLowerCase() !== "docs.google.com" || u.port || u.username || u.password) return null;
  let parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "u" && /^\d+$/.test(parts[1] ?? "")) parts = parts.slice(2);
  if (parts[0] !== "presentation") return null;
  parts = parts.slice(1);
  if (parts[0] === "u" && /^\d+$/.test(parts[1] ?? "")) parts = parts.slice(2);
  return parts;
}

/**
 * The deck id from any link people paste: /edit, /view, /present, /pub,
 * ?usp=sharing, /u/0/ variants, with or without https://.
 */
export function parseSlidesUrl(input: string): { id: string } | null {
  const parts = presentationPath(input);
  if (!parts || parts[0] !== "d") return null;
  const id = parts[1] ?? "";
  if (id === "e" || !ID_RE.test(id)) return null;
  return { id };
}

/**
 * "Publish to the web" links (/d/e/2PACX-…) carry a different id that the
 * export endpoint doesn't accept, so they get their own message.
 */
export function isPublishedSlidesUrl(input: string): boolean {
  const parts = presentationPath(input);
  return !!parts && parts[0] === "d" && parts[1] === "e" && ID_RE.test(parts[2] ?? "");
}

/** Why a link can't be used, or null when it can. */
export function slidesLinkProblem(input: string): "invalid" | "published" | null {
  if (parseSlidesUrl(input)) return null;
  return isPublishedSlidesUrl(input) ? "published" : "invalid";
}

export function exportUrl(id: string, format: SlidesFormat): string {
  if (!ID_RE.test(id)) throw new SlidesError("invalid");
  return `https://docs.google.com/presentation/d/${id}/export/${format}`;
}

/** Only Google's document and download hosts, over https, on the default port. */
export function isAllowedSlidesHost(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return (
      u.protocol === "https:" &&
      !u.port &&
      !u.username &&
      !u.password &&
      (host === "docs.google.com" || (host.endsWith(".googleusercontent.com") && host.length > ".googleusercontent.com".length))
    );
  } catch {
    return false;
  }
}

/** Google's "unusual traffic" check, which it redirects busy server IPs to. */
function isBotCheckUrl(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return (host === "www.google.com" || host === "google.com") && u.pathname.startsWith("/sorry");
}

function isSignInUrl(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return host === "accounts.google.com" || (host === "docs.google.com" && /ServiceLogin|\/accounts\//i.test(u.pathname));
}

const MAX_HOPS = 5;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface SlidesFile {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  /** Only when the upstream length is the real byte count (no content encoding). */
  contentLength: number | null;
  filename: string;
  /** Releases the upstream connection when the file won't be used. */
  cancel: () => Promise<void>;
}

async function discard(res: Response) {
  try {
    await res.body?.cancel();
  } catch {
    /* already closed */
  }
}

/** Fetches the export, following up to five redirects within Google. */
export async function fetchSlidesExport(
  id: string,
  format: SlidesFormat,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal
): Promise<SlidesFile> {
  let url = exportUrl(id, format);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetcher(url, {
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PDFWizard/1.0)",
          Accept: `${SLIDES_MIME[format]}, */*;q=0.1`,
          "Accept-Encoding": "identity",
        },
      });
    } catch {
      throw new SlidesError("unreachable");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await discard(res);
      if (!location) throw new SlidesError("unreachable");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new SlidesError("unreachable");
      }
      if (isSignInUrl(next)) throw new SlidesError("private");
      if (isBotCheckUrl(next)) throw new SlidesError("rate-limited");
      if (!isAllowedSlidesHost(next.href) || hop + 1 > MAX_HOPS) throw new SlidesError("unreachable");
      url = next.href;
      continue;
    }

    if (!res.ok) {
      await discard(res);
      if (res.status === 401 || res.status === 403) throw new SlidesError("private");
      if (res.status === 404 || res.status === 410) throw new SlidesError("not-found");
      if (res.status === 429) throw new SlidesError("rate-limited");
      throw new SlidesError("unreachable");
    }

    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== SLIDES_MIME[format]) {
      await discard(res);
      // Google answers a private deck with its sign-in page.
      throw new SlidesError(type === "text/html" ? "private" : "unreachable");
    }
    if (!res.body) throw new SlidesError("unreachable");

    const encoding = (res.headers.get("content-encoding") ?? "identity").toLowerCase();
    const length = Number(res.headers.get("content-length"));
    const body = res.body;
    return {
      body,
      contentType: SLIDES_MIME[format],
      contentLength: encoding === "identity" && Number.isFinite(length) && length > 0 ? length : null,
      filename: slidesFilename(res.headers.get("content-disposition"), id, format),
      cancel: () => body.cancel().catch(() => {}),
    };
  }
}

/** The file name from a Content-Disposition header, preferring RFC 5987 filename*. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*([^;]+)/i);
  if (star) {
    const m = star[1].trim().match(/^([\w!#$%&+^`{}~-]+)'[^']*'(.+)$/);
    if (m) {
      try {
        const value = decodeURIComponent(m[2].replace(/^"|"$/g, ""));
        if (value.trim()) return value;
      } catch {
        /* fall back to filename= */
      }
    }
  }
  const quoted = header.match(/(?:^|;)\s*filename\s*=\s*"((?:\\.|[^"\\])*)"/i);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1") || null;
  const bare = header.match(/(?:^|;)\s*filename\s*=\s*([^;\s]+)/i);
  return bare ? bare[1] : null;
}

/** A safe download name ending in the right extension. */
export function slidesFilename(disposition: string | null, id: string, format: SlidesFormat): string {
  const raw = filenameFromDisposition(disposition) ?? "";
  let base = raw
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, " ")
    .replace(/\.(pdf|pptx)$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
  if ([...base].length > 120) base = [...base].slice(0, 120).join("").trim();
  return `${base || `slides-${id}`}.${format}`;
}

/** attachment; filename="ascii"; filename*=UTF-8''utf8 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

// Built on first use: the importer imports this module, and a top-level
// schema would pull zod into the browser bundle.
let querySchema: z.ZodType<{ url: string; format: SlidesFormat }, z.ZodTypeDef, unknown> | null = null;
function slidesQuerySchema() {
  return (querySchema ??= z.object({
    url: z.string().trim().min(4).max(2000),
    format: z.enum(["pdf", "pptx"]),
  }));
}

export interface SlidesExportDeps {
  fetcher?: Fetcher;
  resolveTier: () => Promise<{ user: { id: string } | null; tier: Tier }>;
  consumeDaily: (key: string, limit: number) => number;
  clientIp: (request: Request) => string;
}

const noStore = { "Cache-Control": "private, no-store" };

function fail(kind: SlidesFailure) {
  return Response.json({ error: SLIDES_FAILURE_MESSAGE[kind] }, { status: SLIDES_FAILURE_STATUS[kind], headers: noStore });
}

/**
 * GET /api/slides/export?url=<share link>&format=pdf|pptx. The daily import
 * allowance is only spent once Google has actually sent the file.
 */
export async function handleSlidesExport(request: Request, deps: SlidesExportDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = slidesQuerySchema().safeParse({ url: params.get("url") ?? "", format: params.get("format") ?? "" });
  if (!parsed.success) {
    const badFormat = parsed.error.issues.some((i) => i.path[0] === "format");
    return badFormat
      ? Response.json({ error: "Choose PDF or PPTX." }, { status: 400, headers: noStore })
      : fail("invalid");
  }
  const problem = slidesLinkProblem(parsed.data.url);
  if (problem) return fail(problem);
  const { id } = parseSlidesUrl(parsed.data.url)!;
  const format = parsed.data.format;

  const { user, tier } = await deps.resolveTier();

  let file: SlidesFile;
  try {
    file = await fetchSlidesExport(id, format, deps.fetcher ?? fetch, request.signal);
  } catch (err) {
    return fail(err instanceof SlidesError ? err.kind : "unreachable");
  }

  const remaining = deps.consumeDaily(
    `slides:${user ? `u:${user.id}` : `ip:${deps.clientIp(request)}`}`,
    limitsFor(tier).linkImportsPerDay
  );
  if (remaining < 0) {
    await file.cancel();
    return Response.json(
      { error: "You've used today's imports.", upgrade: tier !== "pro" && tier !== "team", reason: "quota" },
      { status: 429, headers: noStore }
    );
  }

  const headers = new Headers({
    "Content-Type": file.contentType,
    "Content-Disposition": contentDisposition(file.filename),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Imports-Remaining": String(remaining),
  });
  if (file.contentLength) headers.set("Content-Length", String(file.contentLength));
  return new Response(file.body, { status: 200, headers });
}
