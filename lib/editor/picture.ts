/**
 * Pictures picked for the editor. A PDF takes JPEG and PNG only, and the file
 * dialog's type filter is just a hint: "All files" lets a WebP, a GIF or an
 * iPhone's HEIC through.
 */
import { sniffImage } from "@/lib/pdf/images";

export const PICTURE_MESSAGE = "Use a JPG or PNG image.";

/** iOS Safari leaves a larger canvas blank. */
const MAX_PIXELS = 4096 * 4096;

function dataUrl(bytes: Uint8Array, type: string): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

/** Any other picture the browser can show, drawn again as a PNG; null if it can't. */
async function redrawAsPng(file: Blob): Promise<Uint8Array | null> {
  if (typeof document === "undefined" || typeof Image === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const { naturalWidth: w, naturalHeight: h } = img;
    if (!w || !h) return null;
    const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(w * fit));
    canvas.height = Math.max(1, Math.floor(h * fit));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    canvas.width = canvas.height = 0;
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The picked file as a JPEG or PNG data URL, ready to place on a page. Other
 * pictures are drawn again as PNG where the browser can open them (Safari
 * opens HEIC); anything else throws PICTURE_MESSAGE.
 */
export async function pictureDataUrl(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (kind) return dataUrl(bytes, `image/${kind}`);
  const png = await redrawAsPng(file);
  if (!png) throw new Error(PICTURE_MESSAGE);
  return dataUrl(png, "image/png");
}
