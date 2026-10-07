/**
 * Client side of the daily edit allowance (app/api/usage/edit). Edit PDF,
 * Sign PDF and Edit PPTX ask right before they build a file to save or
 * download; the server says whether it's allowed and whether the file gets
 * the "Made with PDF Wizard" mark.
 */

/** The mark on Free files from Edit PDF, Sign PDF and Edit PPTX. */
export const WATERMARK_TEXT = "Made with PDF Wizard";

export interface EditGrant {
  allowed: boolean;
  /** Edits left today; null when unlimited. */
  remaining: number | null;
  watermark: boolean;
}

/** SHA-256 (hex) over the parts, length-prefixed so different splits never collide. */
export async function documentFingerprint(...parts: (Uint8Array | string)[]): Promise<string> {
  const enc = new TextEncoder();
  const chunks = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const total = chunks.reduce((n, c) => n + 8 + c.byteLength, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let at = 0;
  for (const c of chunks) {
    view.setFloat64(at, c.byteLength);
    buf.set(c, at + 8);
    at += 8 + c.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class EditCheckError extends Error {}

/** Asks the server for one edit of this document. Throws EditCheckError when it can't be reached. */
export async function requestEdit(doc: string, fetcher: typeof fetch = fetch): Promise<EditGrant> {
  let res: Response;
  try {
    res = await fetcher("/api/usage/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc }),
    });
  } catch {
    throw new EditCheckError("Couldn't reach PDF Wizard. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => null)) as Partial<EditGrant> | null;
  if (!data || typeof data.allowed !== "boolean" || (res.status !== 200 && res.status !== 429)) {
    throw new EditCheckError("Couldn't save right now. Try again.");
  }
  return { allowed: data.allowed, remaining: data.remaining ?? null, watermark: data.watermark !== false };
}
