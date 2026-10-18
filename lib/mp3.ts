/**
 * MP4 → MP3 in the browser with ffmpeg.wasm (single-threaded core, so no
 * cross-origin isolation headers are needed).
 *
 * Talks to the vendored ffmpeg.wasm worker directly instead of importing
 * @ffmpeg/ffmpeg, so the bundler never has to process its worker. The files
 * are copied into public/vendor by scripts/copy-vendor.mjs; these versions
 * are pinned in package.json and checked by tests/x-video.test.mts.
 */
import { readToBlob } from "./read-response";

export const FFMPEG_VERSION = "0.12.15";
export const FFMPEG_CORE_VERSION = "0.12.10";
/** Size of that version's ffmpeg-core.wasm, for its download progress. */
export const FFMPEG_CORE_BYTES = 32_232_419;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export interface AudioStream {
  kbps: number | null;
  channels: number | null;
  /** HE-AAC rebuilds its top octave, so it sounds better than its bitrate. */
  heAac: boolean;
}

/**
 * The first audio stream in an ffmpeg log, e.g.
 * "Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)"
 */
export function parseAudioStream(log: string): AudioStream | null {
  const line = log.split("\n").find((l) => /Stream #\d+:\d+.*: Audio: /.test(l));
  if (!line) return null;
  const layout = line.match(/\d+ Hz, ([^,]+),/)?.[1]?.trim() ?? "";
  const channels =
    layout === "mono" ? 1 : layout === "stereo" ? 2 : Number(layout.match(/^(\d+) channels/)?.[1]) || (layout ? 2 : null);
  return {
    kbps: Number(line.match(/(\d+(?:\.\d+)?) kb\/s/)?.[1]) || null,
    channels,
    heAac: /HE-AAC/i.test(line),
  };
}

/** Average stereo bitrates (kbps) of LAME's VBR levels V0…V9. */
const LAME_VBR_KBPS = [245, 225, 190, 175, 165, 130, 115, 100, 85, 65];

/**
 * LAME VBR level (-q:a) for a source: about 1.4× its bitrate, from V6 to V2.
 * A low-bitrate source gains nothing from a big MP3, and V2 is already
 * transparent for almost everyone. Unknown sources get V2.
 */
export function mp3VbrLevel(src: AudioStream | null): number {
  if (!src?.kbps) return 2;
  // Compare as stereo: a mono stream needs about half the bits.
  const kbps = src.kbps * (src.channels === 1 ? 2 : 1) * (src.heAac ? 2 : 1);
  const target = kbps * 1.4;
  let level = 2;
  for (let v = 3; v <= 6; v++) {
    if (Math.abs(LAME_VBR_KBPS[v] - target) < Math.abs(LAME_VBR_KBPS[level] - target)) level = v;
  }
  return level;
}

/** A failure worth showing as is. */
export class ConvertError extends Error {}

export interface Mp3Converter {
  convert(input: Uint8Array, onProgress?: (fraction: number) => void): Promise<Uint8Array>;
  /** Stops the converter; anything pending rejects. */
  dispose(): void;
}

/** "Downloading the converter… 12 of 31 MB", while the core is on its way (the first time only). */
export function coreDownloadLabel(received: number): string {
  const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));
  return `Downloading the converter… ${mb(received)} of ${mb(FFMPEG_CORE_BYTES)} MB`;
}

/**
 * The converter's core, fetched here so its download can be shown: the first
 * time, a slow line spent minutes on a bar that didn't move. Handed to the
 * worker as a blob: URL; null when it can't be fetched here, and the worker
 * fetches it itself.
 */
async function fetchCore(
  url: string,
  signal?: AbortSignal,
  onDownload?: (fraction: number, received: number) => void
): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    // Counted against the known size: compressed in transit, the header gives another.
    const wasm = await readToBlob(res, "application/wasm", (_f, received) =>
      onDownload?.(Math.min(1, received / FFMPEG_CORE_BYTES), received)
    );
    return URL.createObjectURL(wasm);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

/**
 * Starts ffmpeg.wasm (a ~31 MB core). Start it while the video downloads,
 * so the conversion can begin as soon as the bytes are in. `onDownload`
 * follows the core's download.
 */
export async function loadMp3Converter(
  signal?: AbortSignal,
  onDownload?: (fraction: number, received: number) => void
): Promise<Mp3Converter> {
  const origin = window.location.origin;
  const worker = new Worker(`${origin}/vendor/ffmpeg/${FFMPEG_VERSION}/worker.js`, { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let onProgress: ((fraction: number) => void) | undefined;
  let disposed = false;
  /** ffmpeg's log lines, while something is listening. */
  let log: string[] | null = null;

  const failAll = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    worker.terminate();
    failAll(new DOMException("Cancelled.", "AbortError"));
  };
  signal?.addEventListener("abort", dispose, { once: true });

  worker.onmessage = ({ data: { id, type, data } }) => {
    if (type === "PROGRESS") {
      if (typeof data?.progress === "number" && data.progress >= 0) onProgress?.(Math.min(1, data.progress));
      return;
    }
    if (type === "LOG") {
      if (log && typeof data?.message === "string") log.push(data.message);
      return;
    }
    if (id === undefined) return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (type === "ERROR") p.reject(new Error(String(data)));
    else p.resolve(data);
  };
  worker.onerror = (e) => failAll(new Error(e.message || "Audio converter failed to start."));

  const send = <T>(type: string, data: unknown, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      if (disposed) return reject(new DOMException("Cancelled.", "AbortError"));
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, type, data }, transfer);
    });

  try {
    if (signal?.aborted) throw new DOMException("Cancelled.", "AbortError");
    const core = `${origin}/vendor/ffmpeg-core/${FFMPEG_CORE_VERSION}`;
    const wasm = await fetchCore(`${core}/ffmpeg-core.wasm`, signal, onDownload);
    try {
      await send("LOAD", { coreURL: `${core}/ffmpeg-core.js`, wasmURL: wasm ?? `${core}/ffmpeg-core.wasm` });
    } finally {
      if (wasm) URL.revokeObjectURL(wasm);
    }
  } catch (err) {
    dispose();
    throw err;
  }

  return {
    async convert(input, progress) {
      onProgress = progress;
      try {
        await send("WRITE_FILE", { path: "in.mp4", data: input }, [input.buffer]);
        // Read the audio stream first (no output file, so ffmpeg only probes),
        // then pick the MP3 quality from it.
        log = [];
        await send<number>("EXEC", { args: ["-nostdin", "-hide_banner", "-i", "in.mp4"], timeout: 30_000 }).catch(() => -1);
        const src = parseAudioStream(log.join("\n"));
        log = null;
        const code = await send<number>("EXEC", {
          args: [
            "-nostdin", "-y", "-i", "in.mp4", "-vn",
            ...(src?.channels === 1 ? ["-ac", "1"] : []),
            "-c:a", "libmp3lame", "-q:a", String(mp3VbrLevel(src)), "out.mp3",
          ],
          timeout: -1,
        });
        if (code !== 0) throw new ConvertError("This video's audio couldn't be converted.");
        return await send<Uint8Array>("READ_FILE", { path: "out.mp3", encoding: "binary" });
      } finally {
        dispose();
      }
    },
    dispose,
  };
}

export async function mp4ToMp3(input: Uint8Array, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  return (await loadMp3Converter(signal)).convert(input, onProgress);
}
