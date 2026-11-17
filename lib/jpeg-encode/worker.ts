/**
 * Encodes JPEGs with MozJPEG in a Web Worker, so rendering a long PDF to
 * pictures doesn't freeze the page (see off-thread.ts). One worker serves the
 * page's lifetime: each request carries an id, answered in its reply.
 */
import { encodeJpeg, type JpegOptions, type RawImage } from "../image-codec";

export type Request = { id: number; pixels: RawImage; opts: JpegOptions };
export type Reply = { id: number; bytes: Uint8Array } | { id: number; error: string };

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Request>) => void) | null;
  postMessage(message: Reply, transfer?: Transferable[]): void;
};

scope.onmessage = async ({ data: { id, pixels, opts } }) => {
  try {
    const bytes = await encodeJpeg(pixels, opts);
    scope.postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
