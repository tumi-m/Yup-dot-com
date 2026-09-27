import { z } from "zod";
import {
  maxHeightFor,
  mediaWorkerUrl,
  parseMediaUrl,
  QUALITIES,
  signMediaToken,
} from "@/lib/media";
import { limitsFor } from "@/lib/limits";
import { resolveTier } from "@/lib/tier";
import { clientIp, consumeDaily } from "@/lib/quota";

export const runtime = "nodejs";

const bodySchema = z.object({
  url: z.string().min(4).max(2000),
  kind: z.enum(["mp4", "mp3"]),
  height: z.number().int().optional(),
});

/**
 * Authorises one download. Plan rules (1080p is Pro) and the daily quota are
 * enforced here, then the worker gets a signed, short-lived token it can
 * verify on its own — so the browser can never raise its own quality.
 */
export async function POST(request: Request) {
  const worker = mediaWorkerUrl();
  const secret = process.env.MEDIA_WORKER_SECRET;
  if (!worker || !secret) {
    return Response.json({ error: "Video downloads aren't set up on this site yet." }, { status: 503 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const media = parseMediaUrl(parsed.data.url);
  if (!media) return Response.json({ error: "Paste a YouTube or X (Twitter) video link." }, { status: 400 });

  const { kind } = parsed.data;
  if (media.platform === "youtube" && kind === "mp3") {
    return Response.json({ error: "Audio-only downloads are available for X posts." }, { status: 400 });
  }

  const { user, tier } = await resolveTier();
  const height = kind === "mp3" ? 0 : (parsed.data.height ?? 720);
  if (kind === "mp4" && !(QUALITIES as readonly number[]).includes(height)) {
    return Response.json({ error: "Unsupported quality." }, { status: 400 });
  }
  if (height > maxHeightFor(tier)) {
    return Response.json(
      { error: `${height}p downloads are part of Pro.`, upgrade: true, reason: "quality" },
      { status: 403 }
    );
  }

  const remaining = consumeDaily(
    `media:${user ? `u:${user.id}` : `ip:${clientIp(request)}`}`,
    limitsFor(tier).mediaDownloadsPerDay
  );
  if (remaining < 0) {
    return Response.json(
      { error: "You've used today's free downloads.", upgrade: tier !== "pro" && tier !== "team", reason: "quota" },
      { status: 429 }
    );
  }

  const token = await signMediaToken({ u: media.canonical, k: kind, h: height }, secret);
  return Response.json({ workerUrl: worker, token, remaining });
}
