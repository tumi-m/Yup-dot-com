import { signingSecret, verifyToken } from "@/lib/media-server";
import { grantRef, refundGrant, wasRefunded } from "@/lib/media-refund";
import { usageStore } from "@/lib/usage";
import { isAllowedVideoUrl } from "@/lib/x-video";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Streams one X video file from video.twimg.com under our own origin, so the
 * browser saves it with a proper filename (a cross-origin link would just
 * play it) and the MP3 converter can read it without CORS.
 *
 * Only accepts URLs inside a token signed by /api/media/link, and only
 * https://video.twimg.com MP4s, so it can't be used as an open proxy.
 *
 * When X refuses the file or the stream breaks, the download is given back
 * to the visitor's daily allowance (once per grant), and the grant is dead.
 */
function allowed(url: string): boolean {
  if (isAllowedVideoUrl(url)) return true;
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
  const grant = verifyToken<{ u?: unknown; n?: unknown }>(token, signingSecret());
  if (!grant || typeof grant.u !== "string" || !allowed(grant.u)) {
    return Response.json({ error: "This download link expired. Start the download again." }, { status: 403 });
  }
  const name = typeof grant.n === "string" && grant.n ? grant.n : "video.mp4";
  const ref = grantRef(grant);
  if (ref && (await wasRefunded(usageStore(), ref).catch(() => false))) {
    return Response.json({ error: "This download link expired. Start the download again." }, { status: 403 });
  }
  const giveBack = () => (ref && method === "GET" ? refundGrant(usageStore(), ref).catch(() => false) : Promise.resolve(false));

  const headers: Record<string, string> = { "User-Agent": "Mozilla/5.0 (compatible; PDFWizard/1.0)" };
  const range = request.headers.get("range");
  if (range) headers.Range = range;

  let upstream: Response;
  try {
    upstream = await fetch(grant.u, { method, headers, signal: request.signal, cache: "no-store" });
  } catch {
    if (!request.signal.aborted) await giveBack();
    return Response.json({ error: "X didn't send the file. Try again." }, { status: 502 });
  }
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel();
    await giveBack();
    const expired = upstream.status === 403 || upstream.status === 404 || upstream.status === 410;
    return Response.json(
      { error: expired ? "X no longer serves this file. Start the download again." : "X didn't send the file. Try again." },
      { status: 502 }
    );
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

/** Passes the file through; if X breaks off mid-file (not the visitor), refunds. */
function refundOnBreak(body: ReadableStream<Uint8Array> | null, visitor: AbortSignal, giveBack: () => Promise<boolean>) {
  if (!body) return null;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        if (!visitor.aborted) await giveBack();
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
