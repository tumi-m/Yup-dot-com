import { z } from "zod";
import { cleanTitle, isYoutubeId, maxHeightFor, parsePlaylistUrl, QUALITIES, youtubeWatchUrl } from "@/lib/media";
import { callWorker, WORKER_CONFIG_HELP, workerConfig } from "@/lib/media-server";
import { resolveTier } from "@/lib/tier";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ url: z.string().min(4).max(2000) });

/**
 * Lists a YouTube playlist: titles, durations and links, nothing downloaded.
 * Each video is then fetched through /api/media/link like any single video,
 * so plan rules and the daily quota apply per video.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const playlist = parsed.success ? parsePlaylistUrl(parsed.data.url) : null;
  if (!playlist) return Response.json({ error: "Paste a YouTube playlist link." }, { status: 400 });

  const config = workerConfig();
  if (!config.ok) {
    console.error(`YouTube downloads disabled: ${WORKER_CONFIG_HELP[config.reason]}`);
    return Response.json({ error: "YouTube downloads aren't switched on for this site yet." }, { status: 503 });
  }
  const { tier } = await resolveTier();
  const result = await callWorker(config, "/playlist", { url: playlist.canonical }, 55_000);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  const body = result.body;
  // Only well-formed video ids leave here; links are rebuilt, never echoed.
  const entries = (Array.isArray(body.entries) ? body.entries : [])
    .filter((e: Record<string, unknown>) => isYoutubeId(e?.id))
    .map((e: Record<string, unknown>) => ({
      id: e.id as string,
      title: cleanTitle(e.title).slice(0, 300) || "Untitled",
      duration: typeof e.duration === "number" && e.duration > 0 ? Math.round(e.duration) : null,
      thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      url: youtubeWatchUrl(e.id as string),
    }));
  if (!entries.length) return Response.json({ error: "This playlist is empty." }, { status: 422 });

  const allowed = maxHeightFor(tier);
  return Response.json({
    id: playlist.id,
    url: playlist.canonical,
    title: cleanTitle(body.title).slice(0, 300) || "Playlist",
    uploader: cleanTitle(body.uploader).slice(0, 200) || null,
    count: typeof body.count === "number" ? Math.max(body.count, entries.length) : entries.length,
    truncated: !!body.truncated,
    entries,
    qualities: QUALITIES.map((h) => ({ height: h, locked: h > allowed })),
  });
}
