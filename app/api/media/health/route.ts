import { WORKER_CONFIG_HELP, workerConfig } from "@/lib/media-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Setup check for the site owner: open /api/media/health after deploying.
 * X needs nothing; YouTube needs the media worker. No secrets are returned,
 * only a fixed set of fields from the worker, and the worker's address only
 * outside production (it is public anyway once a visitor starts a YouTube
 * download, but there is no need to list it here).
 */
export async function GET() {
  const config = workerConfig();
  if (!config.ok) {
    return Response.json({ x: "ready", youtube: { ready: false, problem: WORKER_CONFIG_HELP[config.reason] } });
  }
  const worker = process.env.NODE_ENV === "production" ? undefined : config.url;
  try {
    const res = await fetch(`${config.url}/health`, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
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
