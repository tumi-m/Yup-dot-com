import { z } from "zod";
import { cleanTitle, maxHeightFor, parseMediaUrl, QUALITIES } from "@/lib/media";
import { callWorker, WORKER_CONFIG_HELP, workerConfig } from "@/lib/media-server";
import { resolveTier } from "@/lib/tier";
import { resolveXVideo, X_FAILURE_MESSAGE, XResolveError, xAvailableQualities } from "@/lib/x-video";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ url: z.string().min(4).max(2000) });

/** Preview a link: title, thumbnail, duration, and which qualities this tier can take. */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const media = parsed.success ? parseMediaUrl(parsed.data.url) : null;
  if (!media) {
    return Response.json({ error: "Paste a YouTube or X (Twitter) video link." }, { status: 400 });
  }
  const { tier } = await resolveTier();
  const allowed = maxHeightFor(tier);

  // X: resolved here, no worker needed.
  if (media.platform === "x") {
    try {
      const video = await resolveXVideo(media.id, undefined, media.index);
      const available = xAvailableQualities(video, QUALITIES);
      return Response.json({
        platform: "x",
        title: video.title,
        uploader: video.author ? `@${video.author}` : null,
        duration: video.duration,
        thumbnail: video.thumbnail,
        hasAudio: video.hasAudio,
        qualities: QUALITIES.map((h) => ({ height: h, available: available.includes(h), locked: h > allowed })),
      });
    } catch (err) {
      const kind = err instanceof XResolveError ? err.kind : "unreachable";
      if (!(err instanceof XResolveError)) console.error("x resolve failed:", err);
      return Response.json({ error: X_FAILURE_MESSAGE[kind] }, { status: kind === "unreachable" ? 502 : 422 });
    }
  }

  const config = workerConfig();
  if (!config.ok) {
    console.error(`YouTube downloads disabled: ${WORKER_CONFIG_HELP[config.reason]}`);
    return Response.json({ error: "YouTube downloads aren't switched on for this site yet." }, { status: 503 });
  }
  const result = await callWorker(config, "/info", { url: media.canonical });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  const info = result.body;
  const heights: number[] = Array.isArray(info.heights) ? info.heights : [];
  const tallest = heights.length ? Math.max(...heights) : 0;
  return Response.json({
    platform: media.platform,
    title: cleanTitle(info.title) || "Untitled",
    uploader: cleanTitle(info.uploader) || null,
    duration: info.duration,
    thumbnail: info.thumbnail,
    hasAudio: info.hasAudio,
    // A quality is offered if the source has it (or something close above it).
    qualities: QUALITIES.map((h) => ({
      height: h,
      available: tallest >= h * 0.9,
      locked: h > allowed,
    })),
  });
}
