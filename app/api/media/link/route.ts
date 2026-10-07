import { z } from "zod";
import { maxHeightFor, parseMediaUrl, QUALITIES } from "@/lib/media";
import { signingSecret, signToken, WORKER_CONFIG_HELP, workerConfig } from "@/lib/media-server";
import { limitsFor } from "@/lib/limits";
import { resolveTier } from "@/lib/tier";
import { MEDIA_BUCKET, newGrantRef } from "@/lib/media-refund";
import { consumeDaily, usageSubject } from "@/lib/usage";
import {
  audioSourceVariant,
  pickXVariant,
  resolveXVideo,
  variantQuality,
  X_FAILURE_MESSAGE,
  XResolveError,
  xFilename,
} from "@/lib/x-video";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  url: z.string().min(4).max(2000),
  kind: z.enum(["mp4", "mp3"]),
  height: z.number().int().optional(),
});

/**
 * Authorises one download. Plan rules (1080p is Pro) and the daily quota are
 * enforced here, and the result is a signed, short-lived token, so the
 * browser can never raise its own quality.
 *
 * X: the token names one video.twimg.com file, streamed by /api/media/file.
 * YouTube: the token goes to the media worker, which verifies it itself.
 *
 * Each grant records who it was counted against and a random reference, so
 * a download that fails is given back (lib/media-refund.ts).
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const media = parseMediaUrl(parsed.data.url);
  if (!media) return Response.json({ error: "Paste a YouTube or X (Twitter) video link." }, { status: 400 });

  // YouTube MP3s are extracted by the worker (ffmpeg); X MP3s in the browser.
  const { kind } = parsed.data;

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

  // Resolve (X) or check configuration (YouTube) before spending the quota.
  let grant: (ref: { s: string; c: string }) => Record<string, unknown>;
  if (media.platform === "x") {
    let video;
    try {
      video = await resolveXVideo(media.id, undefined, media.index);
    } catch (err) {
      const k = err instanceof XResolveError ? err.kind : "unreachable";
      return Response.json({ error: X_FAILURE_MESSAGE[k] }, { status: k === "unreachable" ? 502 : 422 });
    }
    if (kind === "mp3" && !video.hasAudio) {
      return Response.json({ error: "This is a GIF, so it has no sound. Download it as MP4 instead." }, { status: 422 });
    }
    const variant = kind === "mp3" ? audioSourceVariant(video) : pickXVariant(video, height);
    const quality = variantQuality(variant);
    // Never hand a free user a file above their plan, whatever was asked for.
    if (kind === "mp4" && quality > maxHeightFor(tier) * 1.15) {
      return Response.json({ error: `${quality}p downloads are part of Pro.`, upgrade: true, reason: "quality" }, { status: 403 });
    }
    const mp4Name = xFilename(video, "mp4", kind === "mp4" ? quality : null);
    grant = (ref) => ({
      mode: kind === "mp3" ? "convert" : "direct",
      href: `/api/media/file?t=${encodeURIComponent(signToken({ u: variant.url, n: mp4Name, ...ref }, signingSecret(), 30 * 60))}`,
      filename: kind === "mp3" ? xFilename(video, "mp3") : mp4Name,
    });
  } else {
    const config = workerConfig();
    if (!config.ok) {
      console.error(`YouTube downloads disabled: ${WORKER_CONFIG_HELP[config.reason]}`);
      return Response.json({ error: "YouTube downloads aren't switched on for this site yet." }, { status: 503 });
    }
    grant = (ref) => ({
      mode: "worker",
      workerUrl: config.url,
      token: signToken({ u: media.canonical, k: kind, h: height, ...ref }, config.secret),
    });
  }

  const subject = usageSubject(request, user);
  const remaining = await consumeDaily(subject, MEDIA_BUCKET, limitsFor(tier).mediaDownloadsPerDay);
  if (remaining < 0) {
    const paid = tier === "pro" || tier === "team";
    return Response.json(
      { error: paid ? "You've used today's downloads." : "You've used today's free downloads.", upgrade: !paid, reason: "quota" },
      { status: 429 }
    );
  }
  return Response.json({ ...grant({ s: subject, c: newGrantRef() }), remaining });
}
