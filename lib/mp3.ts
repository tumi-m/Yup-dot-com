/**
 * MP4 → MP3 in the browser with ffmpeg.wasm (single-threaded core, so no
 * cross-origin isolation headers are needed).
 *
 * Talks to the vendored ffmpeg.wasm worker directly instead of importing
 * @ffmpeg/ffmpeg, so the bundler never has to process its worker. The files
 * are copied into public/vendor by scripts/copy-vendor.mjs; these versions
 * are pinned in package.json and checked by tests/x-video.test.mts.
 */
export const FFMPEG_VERSION = "0.12.15";
export const FFMPEG_CORE_VERSION = "0.12.10";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** A failure worth showing as is. */
export class ConvertError extends Error {}

export interface Mp3Converter {
  convert(input: Uint8Array, onProgress?: (fraction: number) => void): Promise<Uint8Array>;
  /** Stops the converter; anything pending rejects. */
  dispose(): void;
}

/**
 * Starts ffmpeg.wasm (a ~31 MB core). Start it while the video downloads,
 * so the conversion can begin as soon as the bytes are in.
 */
export async function loadMp3Converter(signal?: AbortSignal): Promise<Mp3Converter> {
  const origin = window.location.origin;
  const worker = new Worker(`${origin}/vendor/ffmpeg/${FFMPEG_VERSION}/worker.js`, { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let onProgress: ((fraction: number) => void) | undefined;
  let disposed = false;

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
    if (type === "LOG" || id === undefined) return;
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
    await send("LOAD", { coreURL: `${core}/ffmpeg-core.js`, wasmURL: `${core}/ffmpeg-core.wasm` });
  } catch (err) {
    dispose();
    throw err;
  }

  return {
    async convert(input, progress) {
      onProgress = progress;
      try {
        await send("WRITE_FILE", { path: "in.mp4", data: input }, [input.buffer]);
        const code = await send<number>("EXEC", {
          args: ["-nostdin", "-y", "-i", "in.mp4", "-vn", "-c:a", "libmp3lame", "-q:a", "2", "out.mp3"],
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
