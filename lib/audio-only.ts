/**
 * The sound of a video as an audio-only MP4 (M4A). The audio is copied as
 * it is, nothing is decoded, so this runs on the server without WebCodecs.
 *
 * Used when an MP3 is asked for and the only file a post has is above the
 * visitor's plan: the browser gets the sound to convert, never the video.
 */
import { ALL_FORMATS, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, type Source } from "mediabunny";

/** The file has no sound that can be copied into an M4A. */
export class NoAudioError extends Error {}

export async function audioOnlyMp4(source: Source, signal?: AbortSignal): Promise<Uint8Array> {
  const input = new Input({ source, formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const stop = () => input.dispose();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const conversion = await Conversion.init({ input, output, video: { discard: true }, showWarnings: false });
    if (!conversion.isValid || !conversion.utilizedTracks.some((t) => t.isAudioTrack())) {
      throw new NoAudioError("No audio track to copy.");
    }
    await conversion.execute();
    return new Uint8Array(target.buffer!);
  } finally {
    signal?.removeEventListener("abort", stop);
    input.dispose();
  }
}
