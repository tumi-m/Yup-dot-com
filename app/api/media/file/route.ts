import { signingSecret, verifyToken } from "@/lib/media-server";
import { grantRef, refundGrant, refundUnserved, startServing, wasRefunded } from "@/lib/media-refund";
import { usageStore } from "@/lib/usage";
import { grantHeaders, isAllowedMediaUrl, isDirectPlatform, type DirectPlatform } from "@/lib/social/direct";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Streams one video file from X, TikTok or Instagram under our own origin,
 * so the browser saves it with a proper filename (a cross-origin link would
 * just play it) and the MP3 converter can read it without CORS.
 *
 * Only accepts URLs inside a token signed by /api/media/link, and only on
 * that platform's video CDN (lib/social/direct.ts), so it can't be used as an
 * open proxy. The token may carry the Cookie/Referer the CDN asked for.
 *
 * When X refuses the file or the stream breaks before the grant ever sent a
 * file, the download is given back to the visitor's daily allowance (once
 * per grant), and the grant is dead. Once a grant has sent a file, later
 * failures (say, a Range past the end) are not refunded.
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

async function handle(request: Request, method: "GET" | "HEAD") {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const grant = verifyToken<{ u?: unknown; n?: unknown; p?: unknown; h?: unknown }>(token, signingSecret());
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
  let firstServe = false;
  /**
   * Gives the download back if this grant never sent its file, or (with
   * `streamBroke`) if X broke off the first send of it.
   */
  const giveBack = async (streamBroke = false): Promise<boolean> => {
    if (!ref || method !== "GET") return false;
    if (streamBroke) return firstServe ? refundGrant(store, ref).catch(() => false) : false;
    return refundUnserved(store, ref).catch(() => false);
  };

  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (compatible; PDFWizard/1.0)", ...grantHeaders(grant.h) };
  const range = request.headers.get("range");
  if (range) headers.Range = range;

  let upstream: Response | null = null;
  try {
    let url = grant.u;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(url, { method, headers, signal: request.signal, cache: "no-store", redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) {
        upstream = res;
        break;
      }
      await res.body?.cancel();
      const next = new URL(location, url).toString();
      if (!allowed(next, platform)) break;
      url = next;
    }
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
    "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
