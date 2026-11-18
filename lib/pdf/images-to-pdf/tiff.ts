/**
 * TIFF pages to pixels with UTIF (MIT, loaded only when a TIFF is chosen).
 * Each page of a multi-page TIFF (a fax, a scanner's document) becomes a
 * page of the PDF; reduced-size previews stored beside them are skipped.
 * Pure JavaScript, so it runs in the worker and in Node tests alike.
 */
import type { Frame } from "./decode";

/** More pages than any scanner makes; a longer chain is a damaged file. */
const MAX_PAGES = 2000;
/** Larger pages would take a gigabyte or more to decode. */
const MAX_PIXELS = 50e6;
/** Bytes per value of each TIFF field type (1 BYTE … 13 IFD). */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/**
 * Where each page's directory starts, checked before UTIF reads any of it:
 * UTIF follows a chain that loops back forever, and trusts counts that run
 * past the end of the file. Null when the file is damaged that way.
 */
export function tiffDirectories(bytes: Uint8Array): number[] | null {
  if (bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  const offsets: number[] = [];
  const seen = new Set<number>();
  let at = u32(4);
  while (at) {
    if (seen.has(at) || at + 2 > bytes.length || offsets.length >= MAX_PAGES) return offsets.length ? offsets : null;
    seen.add(at);
    const count = u16(at);
    if (at + 2 + count * 12 + 4 > bytes.length) return offsets.length ? offsets : null;
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      const size = TYPE_SIZE[u16(entry + 2)] ?? 0;
      const n = u32(entry + 4);
      // Values over 4 bytes sit elsewhere in the file: they must fit in it.
      if (size && n * size > 4 && u32(entry + 8) + n * size > bytes.length) return null;
      if (size && n * size > bytes.length) return null;
    }
    offsets.push(at);
    at = u32(at + 2 + count * 12);
  }
  return offsets.length ? offsets : null;
}

type Ifd = Record<string, unknown> & { width?: number; height?: number; data?: Uint8Array };
const first = (ifd: Ifd, tag: number): number | undefined => (ifd[`t${tag}`] as number[] | undefined)?.[0];
const all = (ifd: Ifd, tag: number): number[] => (ifd[`t${tag}`] as number[] | undefined) ?? [];

/**
 * The most each compression can grow its data: none, PackBits, LZW and
 * Deflate. Fax and JPEG data can shrink a page much further, so for them
 * only where the data sits is checked.
 */
const MAX_GROWTH: Record<number, number> = { 1: 1, 32773: 64, 5: 2731, 8: 1032, 32946: 1032 };

/**
 * True when a page's data lies inside the file and there is enough of it to
 * fill the page. UTIF reads past the end as zeros, so a cut-off file would
 * otherwise give a blank page, and a tiny one claiming millions of pixels a
 * huge page from nothing.
 */
export function pageDataFits(ifd: Ifd, fileLength: number): boolean {
  const tiled = all(ifd, 324).length > 0;
  const offsets = all(ifd, tiled ? 324 : 273);
  const counts = all(ifd, tiled ? 325 : 279);
  if (!offsets.length || counts.length < offsets.length) return false;
  let total = 0;
  for (const [i, at] of offsets.entries()) {
    if (at + counts[i] > fileLength) return false;
    total += counts[i];
  }
  const growth = MAX_GROWTH[first(ifd, 259) ?? 1];
  if (growth === undefined) return total > 0;
  const samples = first(ifd, 277) ?? 1;
  const bits = all(ifd, 258);
  const perPixel = bits.length >= samples ? bits.slice(0, samples).reduce((a, b) => a + b, 0) : (bits[0] ?? 1) * samples;
  return total * growth * 8 >= first(ifd, 256)! * first(ifd, 257)! * perPixel;
}

/**
 * The pages of a TIFF, decoded one at a time when asked for, so a long fax
 * never holds more than one page of pixels.
 */
export async function tiffPages(bytes: Uint8Array, name: string): Promise<{ count: number; page(i: number): Frame }> {
  const directories = tiffDirectories(bytes);
  if (!directories) throw new Error(`${name}: this image looks damaged.`);
  const mod = await import("utif2");
  // A CommonJS module: its functions arrive as the default export when bundled.
  const UTIF = (mod as unknown as { default?: typeof mod }).default ?? mod;
  // A copy whose chain ends after the last page checked above.
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  const little = copy[0] === 0x49;
  const last = directories[directories.length - 1];
  view.setUint32(last + 2 + view.getUint16(last, little) * 12, 0, little);
  const buffer = copy.buffer as ArrayBuffer;
  let ifds: Ifd[];
  try {
    // (The typings miss the options: no maker notes, no logging.)
    ifds = (UTIF.decode as (b: ArrayBuffer, o: object) => Ifd[])(buffer, { parseMN: false, debug: false });
  } catch {
    throw new Error(`${name}: this image looks damaged.`);
  }
  // NewSubfileType bit 0 marks a smaller copy of another page (a preview).
  const full = ifds.filter((d) => first(d, 256) && first(d, 257));
  const pages = full.some((d) => !((first(d, 254) ?? 0) & 1)) ? full.filter((d) => !((first(d, 254) ?? 0) & 1)) : full;
  if (!pages.length) throw new Error(`${name}: this image looks damaged.`);

  return {
    count: pages.length,
    page(i: number): Frame {
      const ifd = pages[i];
      const width = first(ifd, 256)!;
      const height = first(ifd, 257)!;
      if (width * height > MAX_PIXELS) throw new Error(`${name}: this image is too large to convert on this device.`);
      if (!pageDataFits(ifd, bytes.length)) throw new Error(`${name}: this image looks damaged.`);
      let rgba: Uint8Array;
      try {
        (UTIF.decodeImage as (b: ArrayBuffer, ifd: Ifd, all: Ifd[]) => void)(buffer, ifd, ifds);
        rgba = UTIF.toRGBA8(ifd as never);
      } catch {
        throw new Error(`${name}: this image looks damaged.`);
      } finally {
        // The decoded page stays on the directory otherwise.
        delete ifd.data;
      }
      if (rgba.length < width * height * 4) throw new Error(`${name}: this image looks damaged.`);
      const orientation = first(ifd, 274) ?? 1;
      return {
        pixels: { data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height },
        width,
        height,
        orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
      };
    },
  };
}
