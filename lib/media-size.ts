/**
 * How big each download will be, for the size under each quality chip, and
 * how small the "Smaller file" option would make it. Exact when the platform
 * gives a file size (TikTok's DataSize, or a HEAD request's Content-Length),
 * otherwise bitrate × duration.
 */
import { pickXVariant, variantQuality, type XVariant, type XVideo } from "./x-video";
import { encodedBytes, MAX_IN_MEMORY, targetBitrate, TYPICAL_AUDIO_BITRATE, worthReencoding } from "./video-quality";

export interface QualitySize {
  /** Bytes of the file this quality downloads. */
  size: number;
  /** False when worked out from a bitrate. */
  exact: boolean;
  /** About what the "Smaller file" option makes of it; only when that saves enough and can be done in the tab. */
  smaller?: number;
}

/** A variant's size: exact when known, else from its bitrate. */
export function variantSize(v: XVariant, duration: number | null): { size: number; exact: boolean } | null {
  if (v.size && v.size > 0) return { size: Math.round(v.size), exact: true };
  if (v.bitrate > 1000 && duration && duration > 0) return { size: Math.round((v.bitrate * duration) / 8), exact: false };
  return null;
}

/**
 * Re-encoded size of a variant, if re-encoding would pay off and the file
 * fits in the tab to be re-encoded. 16:9 is assumed when the size is unknown.
 */
export function smallerSize(v: XVariant, size: number, duration: number | null, hasAudio: boolean): number | undefined {
  if (!duration || duration <= 0 || size > MAX_IN_MEMORY) return undefined;
  const short = variantQuality(v);
  const width = v.width && v.height ? v.width : Math.round((short * 16) / 9);
  const height = v.width && v.height ? v.height : short;
  const audio = hasAudio ? TYPICAL_AUDIO_BITRATE : 0;
  const source = Math.max(0, (size * 8) / duration - audio);
  // The frame rate is only known once the file is read. Offer it only when it
  // pays off at 60 fps too, so the browser re-encodes whenever it's offered;
  // the size is for 30 fps, which most posts are.
  if (!worthReencoding(source, targetBitrate(width, height, 60))) return undefined;
  return encodedBytes(targetBitrate(width, height, 30), audio, duration);
}

/** Size per offered quality (by height), for the qualities this post has. */
export function qualitySizes(video: XVideo, heights: readonly number[]): Record<number, QualitySize> {
  const out: Record<number, QualitySize> = {};
  for (const h of heights) {
    const v = pickXVariant(video, h);
    const s = variantSize(v, video.duration);
    if (!s) continue;
    const smaller = smallerSize(v, s.size, video.duration, video.hasAudio);
    out[h] = { ...s, ...(smaller ? { smaller } : {}) };
  }
  return out;
}

/**
 * YouTube: the worker reports a size per frame size (short side). A quality
 * downloads the largest one at or under it, else the smallest, as the
 * worker's own format choice does.
 */
export function workerQualitySizes(sizes: unknown, heights: readonly number[]): Record<number, QualitySize> {
  const out: Record<number, QualitySize> = {};
  if (!sizes || typeof sizes !== "object") return out;
  const known = Object.entries(sizes as Record<string, unknown>)
    .map(([side, bytes]) => [Number(side), Number(bytes)] as const)
    .filter(([side, bytes]) => side > 0 && bytes > 0)
    .sort((a, b) => a[0] - b[0]);
  if (!known.length) return out;
  for (const h of heights) {
    const fit = known.filter(([side]) => side <= h);
    out[h] = { size: Math.round((fit.length ? fit[fit.length - 1] : known[0])[1]), exact: false };
  }
  return out;
}

/**
 * Fills in exact sizes for variants that have neither a size nor a bitrate,
 * with a HEAD request each (in parallel, briefly). Failures are ignored: the
 * chip just shows no size.
 */
export async function probeSizes(
  video: XVideo,
  heights: readonly number[],
  headers: Record<string, string>,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch
): Promise<void> {
  const unknown = [...new Set(heights.map((h) => pickXVariant(video, h)))].filter((v) => !variantSize(v, video.duration));
  await Promise.all(
    unknown.slice(0, 4).map(async (v) => {
      try {
        // No redirects: they could lead off the platform's CDN.
        const res = await fetcher(v.url, { method: "HEAD", headers, redirect: "manual", signal: AbortSignal.timeout(2500), cache: "no-store" });
        const length = Number(res.headers.get("content-length"));
        if (res.ok && length > 0) v.size = length;
      } catch {}
    })
  );
}
