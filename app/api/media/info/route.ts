import { z } from "zod";
import { maxHeightFor, mediaWorkerUrl, parseMediaUrl, QUALITIES } from "@/lib/media";
import { resolveTier } from "@/lib/tier";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ url: z.string().min(4).max(2000) });

/** Preview a link: title, thumbnail, duration, and which qualities this tier can take. */
export async function POST(request: Request) {
  const worker = mediaWorkerUrl();
  const secret = process.env.MEDIA_WORKER_SECRET;
  if (!worker || !secret) {
    return Response.json({ error: "Video downloads aren't set up on this site yet." }, { status: 503 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const media = parsed.success ? parseMediaUrl(parsed.data.url) : null;
  if (!media) {
    return Response.json({ error: "Paste a YouTube or X (Twitter) video link." }, { status: 400 });
  }

  const { tier } = await resolveTier();
  let res: Response;
  try {
    res = await fetch(`${worker}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ url: media.canonical }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    return Response.json({ error: "The download service didn't respond. Try again shortly." }, { status: 502 });
  }
  const info = await res.json().catch(() => ({}));
  if (!res.ok) {
    return Response.json({ error: info.error ?? "Couldn't read that link." }, { status: res.status === 422 ? 422 : 502 });
  }

  const heights: number[] = info.heights ?? [];
  const tallest = heights.length ? Math.max(...heights) : 0;
  const allowed = maxHeightFor(tier);
  return Response.json({
    platform: media.platform,
    title: info.title,
    uploader: info.uploader,
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
