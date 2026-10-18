import { UrlSource } from "mediabunny";
import { audioOnlyMp4, NoAudioError } from "@/lib/audio-only";
import { openToken, signingSecret } from "@/lib/media-server";
import { grantRef, refundGrant, refundUnserved, startServing, wasRefunded } from "@/lib/media-refund";
import { usageStore } from "@/lib/usage";
import { FETCH_UA, grantHeaders, isAllowedMediaUrl, isDirectPlatform, type DirectPlatform } from "@/lib/social/direct";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Streams one video file from X, TikTok or Instagram under our own origin,
 * so the browser saves it with a proper filename (a cross-origin link would
 * just play it) and the MP3 converter can read it without CORS.
 *
 * Only accepts URLs inside a token sealed by /api/media/link, and only on
 * that platform's video CDN (lib/social/direct.ts), so it can't be used as an
 * open proxy. The token may carry the Cookie/Referer the CDN asked for; it is
 * encrypted, so the visitor can't skip this route and its bookkeeping.
 *
 * When X refuses the file or the stream breaks before the grant ever sent a
 * file, the download is given back to the visitor's daily allowance (once
 * per grant), and the grant is dead. Once a grant has sent a file, later
 * failures are not refunded, and a failed Range request never is.
 *
 * An audio-only grant (an MP3 from a video above the visitor's plan) gets
 * the sound alone, as an M4A made here; the video never leaves this route.
 *
 * Redirects are followed by hand, and only to allowed hosts.
 */
const MAX_REDIRECTS = 3;
function allowed(url: string, platform: DirectPlatform): boolean {
  if (isAllowedMediaUrl(url, platform)) return true;
  // Local test servers, never in production.
  const extra = process.env.NODE_ENV !== "production" ? process.env.MEDIA_TEST_HOSTS : undefined;
  if (!extra) return false;
  try {
    return extra.split(",").map((h) => h.trim()).includes(new URL(url).host);
  } catch {
    return false;
  }
}

function attachment(name: string) {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** fetch() that follows redirects only to allowed hosts; null when one leads elsewhere or too far. */
async function fetchAllowed(url: string, init: RequestInit, platform: DirectPlatform): Promise<Response | null> {
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, { ...init, cache: "no-store", redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel();
    const next = new URL(location, url).toString();
    if (!allowed(next, platform)) return null;
    url = next;
  }
  return null;
}

async function handle(request: Request, method: "GET" | "HEAD") {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const grant = openToken<{ u?: unknown; n?: unknown; p?: unknown; h?: unknown; a?: unknown }>(token, signingSecret());
  // Grants without a platform predate TikTok/Instagram and are X.
  const platform: DirectPlatform | null = grant ? (grant.p === undefined ? "x" : isDirectPlatform(String(grant.p)) ? (grant.p as DirectPlatform) : null) : null;
  if (!grant || !platform || typeof grant.u !== "string" || !allowed(grant.u, platform)) {
    return Response.json({ error: "This download link expired. Start the download again." }, { status: 403 });
  }
  const name = typeof grant.n === "string" && grant.n ? grant.n : "video.mp4";
  const ref = grantRef(grant);
  const store = usageStore();
  const expired = () =>
    Response.json({ error: "This download link expired. Start the download again." }, { status: 403 });
  if (ref && (await wasRefunded(store, ref).catch(() => false))) return expired();
  const range = request.headers.get("range");
  let firstServe = false;
  /**
   * Gives the download back if this grant never sent its file, or (with
   * `streamBroke`) if X broke off the first send of it. Never for a Range
   * request: the visitor picks the range (one past the end makes the CDN
   * answer 416), so its failure says nothing about the file.
   */
  const giveBack = async (streamBroke = false): Promise<boolean> => {
    if (!ref || method !== "GET" || range) return false;
    if (streamBroke) return firstServe ? refundGrant(store, ref).catch(() => false) : false;
    return refundUnserved(store, ref).catch(() => false);
  };

  /**
   * Audio-only grants: the M4A is made here from the CDN's file, read in
   * ranges, and sent whole (a Range request gets all of it).
   */
  async function sendAudio(url: string, platform: DirectPlatform, headers: Record<string, string>) {
    let failed = 0;
    const source = new UrlSource(url, {
      requestInit: { headers },
      getRetryDelay: (attempts) => (attempts < 3 ? 1 : null),
      fetchFn: async (input, init) => {
        try {
          const res = await fetchAllowed(String(input), init ?? {}, platform);
          if (!res?.ok) failed = res?.status ?? 502;
          return res ?? new Response(null, { status: 502 });
        } catch (err) {
          if (!init?.signal?.aborted) failed = 502;
          throw err;
        }
      },
    });
    let audio: Uint8Array;
    try {
      audio = await audioOnlyMp4(source, request.signal);
    } catch (err) {
      if (!request.signal.aborted) await giveBack();
      if (failed) {
        const gone = failed === 403 || failed === 404 || failed === 410;
        return Response.json(
          { error: gone ? "That site no longer serves this file. Start the download again." : "The video site didn't send the file. Try again." },
          { status: 502 }
        );
      }
      if (!(err instanceof NoAudioError)) console.error("audio-only file failed:", err);
      return Response.json({ error: "This video's audio couldn't be read." }, { status: 422 });
    }
    if (ref && method === "GET") {
      const serving = await startServing(store, ref).catch(() => ({ ok: true, first: false }));
      if (!serving.ok) return expired();
    }
    return new Response(method === "HEAD" ? null : (audio as BodyInit), {
      headers: {
        "Content-Type": "audio/mp4",
        "Content-Disposition": attachment(name.replace(/\.mp4$/i, "") + ".m4a"),
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const headers: Record<string, string> = { "User-Agent": FETCH_UA, ...grantHeaders(grant.h) };
  if (grant.a === 1) return sendAudio(grant.u, platform, headers);
  if (range) headers.Range = range;

  let upstream: Response | null = null;
  try {
    upstream = await fetchAllowed(grant.u, { method, headers, signal: request.signal }, platform);
  } catch {
    if (!request.signal.aborted) await giveBack();
    return Response.json({ error: "The video site didn't send the file. Try again." }, { status: 502 });
  }
  if (!upstream) {
    await giveBack();
    return Response.json({ error: "The video site didn't send the file. Try again." }, { status: 502 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    await giveBack();
    const gone = upstream.status === 403 || upstream.status === 404 || upstream.status === 410;
    return Response.json(
      { error: gone ? "That site no longer serves this file. Start the download again." : "The video site didn't send the file. Try again." },
      { status: 502 }
    );
  }
  if (ref && method === "GET") {
    const serving = await startServing(store, ref).catch(() => ({ ok: true, first: false }));
    if (!serving.ok) {
      await upstream.body?.cancel();
      return expired();
    }
    firstServe = serving.first;
  }

  const out = new Headers({
    "Content-Type": "video/mp4",
    "Content-Disposition": attachment(name),
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  });
  for (const h of ["content-length", "content-range", "last-modified", "etag"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(method === "HEAD" ? null : refundOnBreak(upstream.body, request.signal, giveBack), {
    status: upstream.status,
    headers: out,
  });
}

/** Passes the file through; if X breaks off the first send (not the visitor), refunds. */
function refundOnBreak(
  body: ReadableStream<Uint8Array> | null,
  visitor: AbortSignal,
  giveBack: (streamBroke: boolean) => Promise<boolean>
) {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        if (!visitor.aborted) await giveBack(true);
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

export function GET(request: Request) {
  return handle(request, "GET");
}

export function HEAD(request: Request) {
  return handle(request, "HEAD");
}
