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

export async function mp4ToMp3(input: Uint8Array, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const origin = window.location.origin;
  const worker = new Worker(`${origin}/vendor/ffmpeg/${FFMPEG_VERSION}/worker.js`, { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 0;

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
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || "Audio converter failed to start."));
    pending.clear();
  };

  const send = <T>(type: string, data: unknown, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, type, data }, transfer);
    });

  try {
    const core = `${origin}/vendor/ffmpeg-core/${FFMPEG_CORE_VERSION}`;
    await send("LOAD", { coreURL: `${core}/ffmpeg-core.js`, wasmURL: `${core}/ffmpeg-core.wasm` });
    await send("WRITE_FILE", { path: "in.mp4", data: input }, [input.buffer]);
    const code = await send<number>("EXEC", {
      args: ["-nostdin", "-y", "-i", "in.mp4", "-vn", "-c:a", "libmp3lame", "-q:a", "2", "out.mp3"],
      timeout: -1,
    });
    if (code !== 0) throw new Error("This video's audio couldn't be converted.");
    return await send<Uint8Array>("READ_FILE", { path: "out.mp3", encoding: "binary" });
  } finally {
    worker.terminate();
  }
}
