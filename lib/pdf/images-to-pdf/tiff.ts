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
