import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-only configuration and signing for video downloads.
 *
 * Values pasted into a hosting dashboard often carry a trailing newline or
 * lack a scheme. Normalising here matters: fetch() strips header whitespace
 * but HMAC does not, so an untrimmed secret made /info succeed while every
 * download failed as "expired".
 */

export type WorkerConfig =
  | { ok: true; url: string; secret: string }
  | { ok: false; reason: "missing-url" | "missing-secret" | "invalid-url" };

export function workerConfig(): WorkerConfig {
  const rawUrl = process.env.MEDIA_WORKER_URL?.trim();
  const secret = process.env.MEDIA_WORKER_SECRET?.trim();
  if (!rawUrl) return { ok: false, reason: "missing-url" };
  if (!secret) return { ok: false, reason: "missing-secret" };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid-url" };
  // The site is served over https; browsers block requests to http origins.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local) url.protocol = "https:";
  return { ok: true, url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, secret };
}

export const WORKER_CONFIG_HELP: Record<Exclude<WorkerConfig, { ok: true }>["reason"], string> = {
  "missing-url": "MEDIA_WORKER_URL is not set on the web app.",
  "missing-secret": "MEDIA_WORKER_SECRET is not set on the web app.",
  "invalid-url": "MEDIA_WORKER_URL is not a valid URL.",
};

/**
 * Key for tokens the web app signs for itself (X file links). Any configured
 * secret works; without one, links are still host-restricted and short-lived
 * but could be forged, so production should set MEDIA_SIGNING_SECRET.
 */
let warned = false;
export function signingSecret(): string {
  const secret =
    process.env.MEDIA_SIGNING_SECRET?.trim() || process.env.MEDIA_WORKER_SECRET?.trim();
  if (secret) return secret;
  if (!warned) {
    console.warn("MEDIA_SIGNING_SECRET is not set: X download links use an insecure default key.");
    warned = true;
  }
  return "pdf-wizard-unsigned-default";
}

/** base64url(json) + "." + base64url(HMAC-SHA256), with an expiry in `e`. */
export function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds = 600): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, e: Math.floor(Date.now() / 1000) + ttlSeconds })
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string, secret: string): T | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as T & { e?: number };
    if (typeof payload.e !== "number" || payload.e < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export type WorkerResult =
  | { ok: true; body: Record<string, any> }
  | { ok: false; status: number; error: string };

/**
 * POST to the media worker and turn every way it can fail into a message a
 * visitor can act on. The technical cause goes to the server log, where the
 * site owner can see it.
 */
export async function callWorker(
  config: Extract<WorkerConfig, { ok: true }>,
  path: string,
  payload: unknown,
  timeoutMs = 50_000
): Promise<WorkerResult> {
  let res: Response;
  try {
    res = await fetch(`${config.url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.error(`media worker ${path}: ${timedOut ? "timed out" : `unreachable (${String(err)})`} at ${config.url}`);
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: timedOut ? "YouTube took too long to answer. Try again." : "The download server isn't responding. Try again in a minute.",
    };
  }

  const text = await res.text();
  let body: Record<string, any> | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    // An HTML page: a sleeping free-tier host, a proxy error, or the wrong URL.
  }
  if (res.ok && body) return { ok: true, body };

  if (res.status === 401) {
    console.error(`media worker ${path}: 401 — MEDIA_WORKER_SECRET differs between the web app and the worker.`);
    return { ok: false, status: 503, error: "The download server rejected this site. Its key needs updating." };
  }
  if (!body) {
    console.error(`media worker ${path}: HTTP ${res.status}, non-JSON reply from ${config.url}: ${text.slice(0, 200)}`);
    return { ok: false, status: 502, error: "The download server is starting up or misconfigured. Try again in a minute." };
  }
  console.error(`media worker ${path}: HTTP ${res.status} ${body.error ?? ""}`);
  return {
    ok: false,
    status: res.status === 422 || res.status === 400 ? 422 : 502,
    error: typeof body.error === "string" ? body.error : "Couldn't read that link.",
  };
}
