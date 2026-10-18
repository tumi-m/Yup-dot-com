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
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
} from "mediabunny";
import type { ToolContext, ToolFile } from "./pdf/toolkit";
import { canEncodeH264, encoderRequest, planVideo, type VideoPlan, type VideoPreset } from "./video-quality";

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
    out = await compressVideo(file, { preset, signal: ctx.signal, onProgress: (f) => ctx.progress?.(f, "Compressing…") });
  } catch (err) {
    if (err instanceof VideoError || (err instanceof DOMException && err.name === "AbortError")) throw err;
    console.error("compress video:", err);
    throw new VideoError("This video couldn't be compressed in this browser.");
  }
  const base = file.name.replace(/\.[^.]+$/, "") || "video";
  if (out.action === "keep") return { blob: file, filename: file.name };
  // Rewrapped, or converted from another codec without getting smaller: an MP4 of it, not a compressed one.
  const smaller = out.action === "encode" && out.blob.size < file.size;
  return { blob: out.blob, filename: smaller ? `${base}-compressed.mp4` : `${base}.mp4` };
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
    const fps = stats.averagePacketRate || null;
    const plan = planVideo(
      { codec: video.codec, container: CONTAINER[format.mimeType] ?? format.mimeType, width, height, fps, bitrate: stats.averageBitrate },
      preset
    );
    const base = { duration, width, height, sourceBitrate: Math.round(stats.averageBitrate) };
    const keep = (): CompressedVideo => ({ blob: file, action: "keep", targetBitrate: 0, ...base });
    if (plan.action === "keep") return keep();

    if (plan.action === "encode") {
      if (!(await video.canDecode())) throw new VideoError("This browser can't read this video's format.");
      if (!(await canEncodeVideo("avc", { width, height, bitrate: plan.bitrate }))) {
        throw new VideoError("This browser can't make H.264 video at this size.");
      }
    }
    if (signal?.aborted) throw abortError();
    timeEveryFrame(video, 1 / (fps ?? 30));
    const audioTrack = await input.getPrimaryAudioTrack();
    const audio = audioTrack ? await audioOptions(audioTrack) : undefined;
    const blob = await convert(input, plan, { audio, fps, signal, onProgress });
    if (plan.action === "encode" && blob.size >= file.size && video.codec === "avc") {
      // A re-encode that didn't pay off: H.264 keeps its own bits, as the
      // original MP4 or the same streams rewrapped. Other codecs only convert.
      if (format.mimeType === "video/mp4") return keep();
      return { blob: await convert(input, { action: "remux" }, { audio, signal }), action: "remux", targetBitrate: 0, ...base };
    }
    return { blob, action: plan.action, targetBitrate: plan.action === "encode" ? plan.bitrate : 0, ...base };
  } finally {
    input.dispose();
  }
}

type PacketRead = (...args: unknown[]) => Promise<EncodedPacket | null>;

/**
 * Gives a frame that doesn't say how long it lasts the time until the next
 * one. MediaRecorder's WebM (screen recordings) leaves it out for the last
 * frame of every cluster, mediabunny reads that as 0 s, and its conversion
 * drops such frames: a hitch every second and the last frame lost. This
 * wraps mediabunny's own packet reader; without one it does nothing.
 */
function timeEveryFrame(track: InputVideoTrack, frameTime: number) {
  const backing = (track as unknown as { _backing?: Record<string, PacketRead | undefined> })._backing;
  const peek = backing?.getNextPacket;
  if (!backing || !peek) return;
  const timed = async (packet: EncodedPacket | null) => {
    if (packet?.duration === 0) {
      const after = await peek.call(backing, packet, { metadataOnly: true });
      const gap = after ? after.timestamp - packet.timestamp : 0;
      (packet as { duration: number }).duration = gap > 0 ? gap : frameTime;
    }
    return packet;
  };
  for (const name of ["getFirstPacket", "getPacket", "getNextPacket", "getKeyPacket", "getNextKeyPacket"]) {
    const read = backing[name];
    if (read) backing[name] = (...args) => read.apply(backing, args).then(timed);
  }
}

/** Runs one conversion of `input` into an MP4 held in memory. */
async function convert(
  input: Input,
  plan: VideoPlan,
  opts: { audio?: ConversionAudioOptions; fps?: number | null; signal?: AbortSignal; onProgress?: (fraction: number) => void }
): Promise<Blob> {
  const { signal, onProgress } = opts;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const ask = plan.action === "encode" ? encoderRequest(plan.bitrate, opts.fps) : null;
  const rate = ask?.frameRate;
  if (rate) {
    // The encoder reads the frame rate from the output track (see encoderFrameRate).
    const addVideoTrack = output.addVideoTrack.bind(output);
    output.addVideoTrack = (source, meta) => addVideoTrack(source, { ...meta, frameRate: rate });
  }
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: ask ? { codec: "avc", quality: new Quality({ bitrate: ask.bitrate }) } : {},
    audio: opts.audio,
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
  // Aborted while setting up: execute() then stops before encoding a frame.
  if (signal?.aborted) cancel();
  if (onProgress) conversion.onProgress = (p) => onProgress(Math.min(1, Math.max(0, p)));
  try {
    await conversion.execute();
  } catch (err) {
    if (err instanceof ConversionCanceledError || signal?.aborted) throw abortError();
    throw err;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return new Blob([target.buffer!], { type: "video/mp4" });
}

/**
 * AAC and MP3 are copied as they are. Other audio becomes AAC where this
 * browser can make it; uncompressed audio otherwise becomes Opus (MP4 holds
 * it and browsers play it) rather than staying uncompressed, and so does
 * Vorbis, which Safari and QuickTime don't play from an MP4. Anything else
 * is copied (Opus fits in MP4) or converted to what mediabunny can make.
 */
async function audioOptions(track: InputAudioTrack): Promise<ConversionAudioOptions> {
  if (track.codec && PORTABLE_AUDIO.has(track.codec)) return {};
  const channels = track.numberOfChannels;
  const bitrate = channels > 1 ? 128_000 : 96_000;
  const can = (codec: "aac" | "opus", sampleRate: number) =>
    canEncodeAudio(codec, { numberOfChannels: channels, sampleRate, bitrate }).catch(() => false);
  if (await can("aac", track.sampleRate)) return { codec: "aac", quality: new Quality({ bitrate }) };
  const toOpus = !!track.codec && (track.codec.startsWith("pcm-") || track.codec === "flac" || track.codec === "vorbis");
  if (toOpus && (await can("opus", 48_000))) return { codec: "opus", quality: new Quality({ bitrate }), sampleRate: 48_000 };
  return {};
}
