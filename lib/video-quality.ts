/**
 * How many bits a video needs, and when re-encoding it is worth it. Shared by
 * the size estimates on the download page and the in-browser re-encoder
 * (lib/video-compress.ts). Plain numbers only, so the rules run in Node tests.
 *
 * Targets are H.264 bits per pixel per frame at 1080p. Smaller frames get a
 * little more per pixel (there is less redundancy to exploit), frame rates
 * above 30 a little less per frame (consecutive frames differ less).
 * Measured with Chrome's encoder: 720p at 0.086 scored the same SSIM as
 * 1080p at 0.07, and going from 0.07 to 0.1 gained under 0.01 SSIM on
 * three of four test clips (grain-like noise gained 0.026).
 */

export type VideoPreset = "small" | "recommended" | "high";

/** Bits per pixel per frame at 1080p. "recommended" is about 4 Mbps at 1080p30. */
export const BITS_PER_PIXEL: Record<VideoPreset, number> = {
  small: 0.045,
  recommended: 0.07,
  high: 0.1,
};

/**
 * Re-encode only when the source spends this much more than the target.
 * Below it the saving is small and a second generation of compression costs
 * more quality than it is worth, so the original is kept.
 */
export const REENCODE_RATIO = 1.4;

/** Audio is copied, so it counts at what it is; this is the guess when unknown. */
export const TYPICAL_AUDIO_BITRATE = 128_000;

/**
 * Largest download read into the tab. A bigger one is saved by the browser
 * straight from our origin, so "Smaller file" can't re-encode it.
 */
export const MAX_IN_MEMORY = 1024 ** 3;

const FULL_HD = 1920 * 1080;

/** Target H.264 bitrate (bits/s) for a frame size and rate. */
export function targetBitrate(width: number, height: number, fps?: number | null, preset: VideoPreset = "recommended"): number {
  const pixels = Math.max(16 * 16, Math.round(width) * Math.round(height));
  const rate = Math.min(Math.max(fps && fps > 0 ? fps : 30, 10), 120);
  const frames = rate <= 30 ? rate : 30 + (rate - 30) / 2;
  const scale = Math.min(2, Math.max(0.6, (FULL_HD / pixels) ** 0.25));
  return Math.round(pixels * frames * BITS_PER_PIXEL[preset] * scale);
}

/** mediabunny's MP4 timescale when no frame rate is set: 2^8 · 3^2 · 5^2 ticks a second. */
const MP4_TIMESCALE = 57_600;

/**
 * The frame rate to tell the H.264 encoder. Its rate control spends
 * bitrate / frame rate per frame and assumes 30 fps when not told, so 60 fps
 * came out at twice the target and 24 fps at 0.8×. The value is within about
 * 1% of `fps`, written as 57600/k with k sharing no factor with 57600:
 * mediabunny's MP4 writer derives its timescale from it, and this keeps its
 * fine 1/57600 s one instead of snapping frames to a 1/fps grid, which would
 * bunch up variable-frame-rate (phone) video. (Conversion's own frameRate
 * option resamples to that grid and drops or repeats frames.)
 */
export function encoderFrameRate(fps: number | null | undefined): number | undefined {
  if (!fps || !Number.isFinite(fps) || fps < 1 || fps > 480) return undefined;
  const k0 = Math.round(MP4_TIMESCALE / fps);
  const coprime = (k: number) => k > 0 && k % 2 !== 0 && k % 3 !== 0 && k % 5 !== 0;
  for (let d = 0; ; d++) {
    if (coprime(k0 - d)) return MP4_TIMESCALE / (k0 - d);
    if (coprime(k0 + d)) return MP4_TIMESCALE / (k0 + d);
  }
}

/** Chrome's software H.264 encoder (OpenH264) budgets for at most 60 frames a second. */
const ENCODER_MAX_FPS = 60;

/**
 * What to ask the encoder for to get `bitrate` at `fps`: that bitrate and
 * frame rate, except above 60 fps, where it's told 60 and a bitrate scaled
 * to match (an encoder that stops at 60 spent twice the target at 120 fps).
 */
export function encoderRequest(bitrate: number, fps: number | null | undefined): { bitrate: number; frameRate?: number } {
  const frameRate = encoderFrameRate(fps && Math.min(fps, ENCODER_MAX_FPS));
  if (!frameRate || !fps || fps <= ENCODER_MAX_FPS) return { bitrate, frameRate };
  return { bitrate: Math.round((bitrate * ENCODER_MAX_FPS) / fps), frameRate };
}

/** True when the source is wasteful enough that re-encoding pays off. */
export function worthReencoding(sourceBitrate: number, target: number): boolean {
  return sourceBitrate > 0 && target > 0 && sourceBitrate >= target * REENCODE_RATIO;
}

export interface SourceVideo {
  /** "avc" for H.264; anything else is converted for the MP4. */
  codec: string | null;
  /** Container of the file: "mp4", "mov", "webm", … */
  container: string;
  width: number;
  height: number;
  fps: number | null;
  /** Average video bitrate, bits/s. */
  bitrate: number;
}

export type VideoPlan =
  /** Hand back the file as it is. */
  | { action: "keep" }
  /** Copy the streams into an MP4 without re-encoding. */
  | { action: "remux" }
  /** Re-encode the video to H.264 at this bitrate. */
  | { action: "encode"; bitrate: number };

/**
 * What to do with a video to get an H.264 MP4 that's no bigger than it needs
 * to be. H.264 that is already lean is never re-encoded.
 */
export function planVideo(src: SourceVideo, preset: VideoPreset = "recommended"): VideoPlan {
  const target = targetBitrate(src.width, src.height, src.fps, preset);
  if (src.codec === "avc") {
    if (worthReencoding(src.bitrate, target)) return { action: "encode", bitrate: target };
    return src.container === "mp4" ? { action: "keep" } : { action: "remux" };
  }
  // Another codec has to be converted; never spend more bits than it did.
  return { action: "encode", bitrate: src.bitrate > 0 ? Math.round(Math.min(target, src.bitrate)) : target };
}

/** Rough output size of a re-encode, in bytes. */
export function encodedBytes(videoBitrate: number, audioBitrate: number, duration: number): number {
  return Math.round(((videoBitrate + audioBitrate) * duration) / 8);
}

/** "0.8 MB", "8.3 MB", "42 MB": short enough for a chip. */
export function shortBytes(bytes: number): string {
  const MB = 1024 * 1024;
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  return bytes < 10 * MB ? `${Math.max(0.1, bytes / MB).toFixed(1)} MB` : `${Math.round(bytes / MB)} MB`;
}

/**
 * Whether this browser can decode and encode H.264 at 1080p with WebCodecs.
 * Checks High and Main profile, since some hardware encoders only do Main.
 */
export async function canEncodeH264(width = 1920, height = 1080): Promise<boolean> {
  if (typeof VideoEncoder === "undefined" || typeof VideoDecoder === "undefined") return false;
  try {
    const decode = await VideoDecoder.isConfigSupported({ codec: "avc1.640028", codedWidth: width, codedHeight: height });
    if (!decode.supported) return false;
    for (const codec of ["avc1.640028", "avc1.4d0028"]) {
      const encode = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: 4_000_000, framerate: 30 });
      if (encode.supported) return true;
    }
  } catch {}
  return false;
}
