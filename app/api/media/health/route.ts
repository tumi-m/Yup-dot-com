import { timingSafeEqual } from "node:crypto";
import { WORKER_CONFIG_HELP, workerConfig } from "@/lib/media-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** In production, only the owner: the request must carry MEDIA_WORKER_SECRET. */
function ownerOnly(request: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const secret = process.env.MEDIA_WORKER_SECRET?.trim();
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return !!secret && given.length === wanted.length && timingSafeEqual(given, wanted);
}

/**
 * Setup check for the site owner, after deploying:
 *   curl -H "Authorization: Bearer $MEDIA_WORKER_SECRET" https://<site>/api/media/health
 * X needs nothing; YouTube needs the media worker. In production anyone
 * without the secret gets a 404 (it would show versions and setup, and each
 * call makes the server call the worker). No secrets are returned, only a
 * fixed set of fields from the worker, and the worker's address only outside
 * production.
 */
export async function GET(request: Request) {
  if (!ownerOnly(request)) return Response.json({ error: "Not found." }, { status: 404 });
  const config = workerConfig();
  if (!config.ok) {
    return Response.json({ x: "ready", youtube: { ready: false, problem: WORKER_CONFIG_HELP[config.reason] } });
  }
  const worker = process.env.NODE_ENV === "production" ? undefined : config.url;
  try {
    const res = await fetch(`${config.url}/health`, {
      // The worker shows its details only to the web app.
      headers: { Authorization: `Bearer ${config.secret}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      return Response.json({
        x: "ready",
        youtube: { ready: false, worker, problem: `The worker answered HTTP ${res.status} without JSON. Check MEDIA_WORKER_URL.` },
      });
    }
    const problem =
      body.jsRuntime === null || body.jsRuntime === false
        ? "The worker has no JavaScript runtime (Deno), so YouTube will fail. Rebuild it from the current Dockerfile."
        : null;
    // Single videos still work on an older worker; only playlists need the update.
    const playlists = body.playlists === true ? "ready" : "Redeploy the worker from media-worker/ to list playlists.";
    return Response.json({
      x: "ready",
      youtube: {
        ready: !problem,
        worker,
        problem,
        playlists,
        ytdlp: typeof body.ytdlp === "string" ? body.ytdlp.slice(0, 40) : undefined,
        jsRuntime: !!body.jsRuntime,
      },
    });
  } catch {
    return Response.json({
      x: "ready",
      youtube: { ready: false, worker, problem: "The worker didn't respond. Is it running, and is MEDIA_WORKER_URL right?" },
    });
  }
}
