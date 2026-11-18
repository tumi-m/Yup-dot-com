/**
 * The picture formats Images to PDF takes, told apart by their bytes (a
 * renamed file is common), and the file types and extensions each tool page
 * offers in its file picker. Plain data and byte checks: no decoder here.
 */

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "avif" | "heic" | "svg";

/** What people call each format, for messages. */
export const FORMAT_NAMES: Record<ImageFormat, string> = {
  jpeg: "JPG",
  png: "PNG",
  gif: "GIF",
  webp: "WebP",
  bmp: "BMP",
  tiff: "TIFF",
  avif: "AVIF",
  heic: "HEIC",
  svg: "SVG",
};

/** Types and extensions per format, for a file picker's accept list, in the order messages name them. */
const ACCEPT: Record<ImageFormat, string[]> = {
  jpeg: ["image/jpeg", ".jpg", ".jpeg", ".jfif"],
  png: ["image/png", ".png"],
  webp: ["image/webp", ".webp"],
  gif: ["image/gif", ".gif"],
  bmp: ["image/bmp", "image/x-ms-bmp", ".bmp"],
  tiff: ["image/tiff", ".tif", ".tiff"],
  avif: ["image/avif", ".avif"],
  heic: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence", ".heic", ".heif"],
  svg: ["image/svg+xml", ".svg"],
};

export const ALL_FORMATS = Object.keys(ACCEPT) as ImageFormat[];

/** The accept list for a tool that takes these formats. */
export function acceptFor(formats: ImageFormat[]): string {
  return formats.flatMap((f) => ACCEPT[f]).join(",");
}

/** The formats an accept list names, by type or extension, in the usual order. */
export function formatsIn(accept: string): ImageFormat[] {
  const entries = new Set(accept.split(",").map((t) => t.trim().toLowerCase()));
  return ALL_FORMATS.filter((f) => ACCEPT[f].some((t) => entries.has(t)));
}

/** ISO base media brands (the "ftyp" box) of AVIF and HEIC files. */
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "heif"]);

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...bytes.subarray(from, from + length));

/** The format of an image file from its first bytes, or null when it isn't one we take. */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 6 && ascii(b, 0, 4) === "GIF8") return "gif";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if (b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42))) {
    return "tiff";
  }
  if (b.length > 16 && ascii(b, 4, 4) === "ftyp") {
    // The major brand, then the compatible ones; AVIF wins when both appear
    // (an AVIF lists mif1 too).
    const size = Math.min(b.length, (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]);
    const brands: string[] = [ascii(b, 8, 4)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(b, at, 4));
    if (brands.some((x) => AVIF_BRANDS.has(x))) return "avif";
    if (brands.some((x) => HEIC_BRANDS.has(x))) return "heic";
    return null;
  }
  if (looksLikeSvg(b)) return "svg";
  return null;
}

/** An <svg> root near the start of a text file, after any XML declaration, comments or doctype. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^﻿/, "");
  const rest = head.replace(/^(\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, "");
  return /^<svg[\s>]/i.test(rest);
}

/**
 * The size an SVG asks to be drawn at, in CSS pixels, from its width and
 * height (px, pt, in, cm, mm; not %) or else its viewBox; null when it gives
 * neither. Browsers draw a sizeless SVG at 300 x 150, which squashes it.
 */
export function svgSize(text: string): { width: number; height: number } | null {
  const root = text.match(/<svg\b[^>]*>/i)?.[0];
  if (!root) return null;
  const attr = (name: string) => root.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const vb = box && box.length === 4 && box[2] > 0 && box[3] > 0 ? { width: box[2], height: box[3] } : null;
  const width = cssLength(attr("width"));
  const height = cssLength(attr("height"));
  if (width && height) return { width, height };
  if (vb && width) return { width, height: (width * vb.height) / vb.width };
  if (vb && height) return { width: (height * vb.width) / vb.height, height };
  return vb;
}

const UNITS: Record<string, number> = { "": 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

function cssLength(value: string | undefined): number | null {
  const m = value?.trim().match(/^([\d.]+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm)?$/i);
  if (!m) return null;
  const n = Number(m[1]) * UNITS[(m[2] ?? "").toLowerCase()];
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Said when a browser can't open a HEIC photo (only Safari can). */
export const HEIC_MESSAGE =
  "this browser can't open HEIC photos. Open this page in Safari, or save the photo as JPG first. On an iPhone, Settings > Camera > Formats > Most Compatible takes new photos as JPG.";

/** A HEIC photo by its name or type, known before it is read. */
export const looksHeic = (file: { name: string; type: string }) => /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type);
