/**
 * Makes a video a leaner H.264 MP4 in the browser, with WebCodecs through
 * mediabunny. Nothing leaves the device. Resolution and frame timing are
 * kept, audio is copied untouched when MP4 can hold it, and whether to
 * re-encode at all is decided by lib/video-quality.ts: H.264 that is already
 * lean comes back as it was.
 *
 * Load this module only when it's needed (it brings mediabunny).
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  canEncodeVideo,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  type ConversionAudioOptions,
  type InputAudioTrack,
} from "mediabunny";
import type { ToolContext, ToolFile } from "./pdf/toolkit";
import { canEncodeH264, planVideo, type VideoPlan, type VideoPreset } from "./video-quality";

/** A failure worth showing as is. */
export class VideoError extends Error {}

/** Largest frame taken: 4K. */
const MAX_PIXELS = 4096 * 2304;
const PRESETS: readonly VideoPreset[] = ["small", "recommended", "high"];

/** The Compress Video tool: one file in, an H.264 MP4 (or the untouched original) out. */
export async function compressVideoTool(files: File[], opts: { quality: string }, ctx: ToolContext = {}): Promise<ToolFile> {
  const file = files[0];
  if (!(await canEncodeH264())) {
    throw new VideoError("This browser can't compress video. Try a recent Chrome, Edge or Safari.");
  }
  const preset = PRESETS.find((p) => p === opts.quality) ?? "recommended";
  ctx.progress?.(0, "Reading video…");
  let out: CompressedVideo;
  try {
    out = await compressVideo(file, { preset, onProgress: (f) => ctx.progress?.(f, "Compressing…") });
  } catch (err) {
    if (err instanceof VideoError) throw err;
    console.error("compress video:", err);
    throw new VideoError("This video couldn't be compressed in this browser.");
  }
  const base = file.name.replace(/\.[^.]+$/, "") || "video";
  if (out.action === "keep") return { blob: file, filename: file.name };
  return { blob: out.blob, filename: out.action === "remux" ? `${base}.mp4` : `${base}-compressed.mp4` };
}

export interface CompressedVideo {
  blob: Blob;
  /** keep: the input itself; remux: same streams in MP4; encode: re-encoded. */
  action: VideoPlan["action"];
  duration: number;
  width: number;
  height: number;
  /** Source video bitrate and the one aimed for (0 when not re-encoded). */
  sourceBitrate: number;
  targetBitrate: number;
}

const CONTAINER: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv" };
/** Audio an MP4 carries that plays nearly everywhere. */
const PORTABLE_AUDIO = new Set(["aac", "mp3"]);

const abortError = () => new DOMException("Cancelled.", "AbortError");

export async function compressVideo(
  file: Blob,
  opts: { preset?: VideoPreset; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<CompressedVideo> {
  const { preset = "recommended", onProgress, signal } = opts;
  if (signal?.aborted) throw abortError();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const format = await input.getFormat().catch(() => null);
    const video = format ? await input.getPrimaryVideoTrack() : null;
    if (!format || !video) throw new VideoError("This file isn't a video this browser can read.");
    const duration = await input.computeDuration();
    const stats = await video.computePacketStats();
    const width = video.displayWidth;
    const height = video.displayHeight;
    if (width * height > MAX_PIXELS) throw new VideoError("Videos up to 4K can be compressed here.");
    const plan = planVideo(
      {
        codec: video.codec,
        container: CONTAINER[format.mimeType] ?? format.mimeType,
        width,
        height,
        fps: stats.averagePacketRate || null,
        bitrate: stats.averageBitrate,
      },
      preset
    );
    const base = { duration, width, height, sourceBitrate: Math.round(stats.averageBitrate) };
    if (plan.action === "keep") return { blob: file, action: "keep", targetBitrate: 0, ...base };

    if (plan.action === "encode") {
      if (!(await video.canDecode())) throw new VideoError("This browser can't read this video's format.");
      if (!(await canEncodeVideo("avc", { width, height, bitrate: plan.bitrate }))) {
        throw new VideoError("This browser can't make H.264 video at this size.");
      }
    }
    const audio = await input.getPrimaryAudioTrack();
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      video: plan.action === "encode" ? { codec: "avc", quality: new Quality({ bitrate: plan.bitrate }) } : {},
      audio: audio ? await audioOptions(audio) : undefined,
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const lost = conversion.discardedTracks.find((d) => d.track.isVideoTrack()) ?? conversion.discardedTracks[0];
      throw new VideoError(
        lost?.reason === "undecodable_source_codec"
          ? "This browser can't read this video's format."
          : "This video can't be converted in this browser."
      );
    }
    const cancel = () => void conversion.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    if (onProgress) conversion.onProgress = (p) => onProgress(Math.min(1, Math.max(0, p)));
    try {
      await conversion.execute();
    } catch (err) {
      if (err instanceof ConversionCanceledError || signal?.aborted) throw abortError();
      throw err;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
    const blob = new Blob([target.buffer!], { type: "video/mp4" });
    // A re-encode that didn't pay off: the original MP4 is the better file.
    if (plan.action === "encode" && blob.size >= file.size && base.sourceBitrate && video.codec === "avc" && format.mimeType === "video/mp4") {
      return { blob: file, action: "keep", targetBitrate: 0, ...base };
    }
    return { blob, action: plan.action, targetBitrate: plan.action === "encode" ? plan.bitrate : 0, ...base };
  } finally {
    input.dispose();
  }
}

/** Copy AAC/MP3 as is; anything else becomes AAC if this browser can make it. */
async function audioOptions(track: InputAudioTrack): Promise<ConversionAudioOptions> {
  if (track.codec && PORTABLE_AUDIO.has(track.codec)) return {};
  const bitrate = track.numberOfChannels > 1 ? 128_000 : 96_000;
  const aac = await canEncodeAudio("aac", { numberOfChannels: track.numberOfChannels, sampleRate: track.sampleRate, bitrate }).catch(() => false);
  // Otherwise mediabunny copies (Opus fits in MP4) or picks what it can encode.
  return aac ? { codec: "aac", quality: new Quality({ bitrate }) } : {};
}
