import { timingSafeEqual } from "node:crypto";
import { WORKER_CONFIG_HELP, workerConfig } from "@/lib/media-server";
import { HTML_TO_PDF_ENABLED } from "@/lib/web-pdf";

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
 * X needs nothing; YouTube and HTML to PDF need the media worker. In production anyone
 * without the secret gets a 404 (it would show versions and setup, and each
 * call makes the server call the worker). No secrets are returned, only a
 * fixed set of fields from the worker, and the worker's address only outside
 * production.
 */
/** HTML to PDF's part: the flag, then whether the worker can render (and with Chromium's sandbox). */
function htmlToPdfHealth(body: Record<string, unknown> | null, problem?: string) {
  if (!HTML_TO_PDF_ENABLED) return { ready: false, problem: "Off. Set NEXT_PUBLIC_ENABLE_HTML_TO_PDF=1 and redeploy once the worker renders." };
  if (problem || !body) return { ready: false, problem: problem ?? "The worker didn't answer." };
  if (body.render === undefined) return { ready: false, problem: "The worker predates HTML to PDF. Redeploy it from media-worker/." };
  if (body.render !== true) return { ready: false, problem: "The worker can't start Chromium. See its log, and rebuild it from the current Dockerfile." };
  return { ready: true, sandbox: body.renderSandbox === true };
}

export async function GET(request: Request) {
  if (!ownerOnly(request)) return Response.json({ error: "Not found." }, { status: 404 });
  const config = workerConfig();
  if (!config.ok) {
    const problem = WORKER_CONFIG_HELP[config.reason];
    return Response.json({ x: "ready", youtube: { ready: false, problem }, htmlToPdf: htmlToPdfHealth(null, problem) });
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
      const problem = `The worker answered HTTP ${res.status} without JSON. Check MEDIA_WORKER_URL.`;
      return Response.json({ x: "ready", youtube: { ready: false, worker, problem }, htmlToPdf: htmlToPdfHealth(null, problem) });
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
      htmlToPdf: htmlToPdfHealth(body),
    });
  } catch {
    const problem = "The worker didn't respond. Is it running, and is MEDIA_WORKER_URL right?";
    return Response.json({ x: "ready", youtube: { ready: false, worker, problem }, htmlToPdf: htmlToPdfHealth(null, problem) });
  }
}
