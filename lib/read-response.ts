/** Bytes held before they join the Blob: a few megabytes, never the whole file. */
export const HELD_BYTES = 8 * 1024 * 1024;

/**
 * Reads a response into a Blob, and fails on a stream that stops short.
 * Progress is the fraction of the size the response gives (0 when it gives
 * none) and the bytes read. The bytes join the Blob as they come, so the tab
 * never holds the file more than once: kept as chunks, then copied into one
 * array, then into a Blob, a 589 MB video took 1.9 GB.
 */
export async function readToBlob(
  res: Response,
  type: string,
  onProgress: (fraction: number, received: number) => void
): Promise<Blob> {
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body?.getReader();
  if (!reader) return new Blob([await res.arrayBuffer()], { type });
  let blob = new Blob([], { type });
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held.push(value);
    heldBytes += value.length;
    received += value.length;
    if (heldBytes >= HELD_BYTES) {
      blob = new Blob([blob, ...(held as BlobPart[])], { type });
      held = [];
      heldBytes = 0;
    }
    onProgress(total ? Math.min(1, received / total) : 0, received);
  }
  if (total && received < total) throw new Error("incomplete");
  return new Blob([blob, ...(held as BlobPart[])], { type });
}
