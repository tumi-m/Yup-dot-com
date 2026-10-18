// When the MozJPEG wasm can't load, the browser's canvas codec stands in.
// Browsers now apply EXIF rotation even for imageOrientation "none" (Chromium
// 141 does), so the fallback must still decode a phone photo as stored: it is
// drawn with its EXIF orientation later, and resized to a stored-orientation size.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import encodeWasm, { init as initEncoder } from "@jsquash/jpeg/encode.js";
import decodeWasm, { init as initDecoder } from "@jsquash/jpeg/decode.js";
import { jpegOrientation, withoutOrientation } from "../lib/pdf/images.ts";
import { imagesToPdfTool } from "../lib/pdf/toolkit.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// The test's own MozJPEG, to make pictures and to stand in for the browser's
// decoder. The app's copy fetches its wasm from /vendor, which fails here.
const codec = "./node_modules/@jsquash/jpeg/codec/";
await initEncoder(await WebAssembly.compile(readFileSync(codec + "enc/mozjpeg_enc.wasm")));
await initDecoder(await WebAssembly.compile(readFileSync(codec + "dec/mozjpeg_dec.wasm")));

interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Turns stored pixels the way a browser shows them for EXIF 3 or 6. */
function orient(img: Pixels, orientation: number): Pixels {
  if (orientation !== 3 && orientation !== 6) return img;
  const { width: W, height: H } = img;
  const width = orientation === 6 ? H : W;
  const height = orientation === 6 ? W : H;
  const data = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [sx, sy] = orientation === 6 ? [y, H - 1 - x] : [W - 1 - x, H - 1 - y];
      data.set(img.data.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

// The browser, as Chromium 141 behaves: EXIF orientation applied whatever
// imageOrientation says. `turnAnyway` is a browser that turns pictures some other way.
let turnAnyway = false;
const g = globalThis as Record<string, unknown>;
g.createImageBitmap = async (blob: Blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const img = await decodeWasm(bytes.buffer as ArrayBuffer, { preserveOrientation: false });
  return { ...orient(img, turnAnyway ? 6 : jpegOrientation(bytes)), close() {} };
};
g.ImageData = class {
  constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
};
g.OffscreenCanvas = class {
  private px: Pixels | null = null;
  constructor(public width: number, public height: number) {}
  getContext() {
    return {
      drawImage: (bitmap: Pixels) => (this.px = bitmap),
      putImageData: (img: Pixels) => (this.px = img),
      getImageData: () => ({ data: this.px!.data }),
    };
  }
  async convertToBlob({ quality }: { quality: number }) {
    return new Blob([await encodeWasm(this.px as ImageData, { quality: Math.round(quality * 100) })]);
  }
};

const { decodeJpeg } = await import("../lib/image-codec.ts");

let seed = 1;
const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 255;
/** Stored left half red, right half blue (with grain, so it compresses like a photo). */
function redBlue(width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = noise() * 0.25;
      data.set(x < width / 2 ? [190 + n, 30 + n, 30 + n, 255] : [30 + n, 30 + n, 190 + n, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

/** Adds an EXIF orientation tag right after SOI, as phones write it. */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
}

const isRed = (px: ArrayLike<number>, i: number) => px[i] > 140 && px[i + 2] < 100;
const isBlue = (px: ArrayLike<number>, i: number) => px[i + 2] > 140 && px[i] < 100;

const plain = new Uint8Array(await encodeWasm(redBlue(40, 20) as ImageData, { quality: 95 }));
const sideways = withOrientation(plain, 6);

// --- withoutOrientation ------------------------------------------------------
const upright = withoutOrientation(sideways);
check("withoutOrientation: the copy reads upright", jpegOrientation(upright) === 1);
check("withoutOrientation: the original is left alone", jpegOrientation(sideways) === 6);
check("withoutOrientation: only the tag changes", upright.length === sideways.length && upright.filter((b, i) => b !== sideways[i]).length === 1);
const buffer = Buffer.from(sideways);
withoutOrientation(buffer);
check("withoutOrientation: a Node Buffer is copied, not changed", jpegOrientation(buffer) === 6);
check("withoutOrientation: a JPEG without EXIF comes back the same", Buffer.from(withoutOrientation(plain)).equals(Buffer.from(plain)));

// --- decodeJpeg on the canvas fallback ----------------------------------------
const six = await decodeJpeg(sideways);
check("canvas fallback: an EXIF 6 photo decodes at its stored size", six.width === 40 && six.height === 20, [six.width, six.height]);
check("canvas fallback: and in its stored orientation (red left, blue right)", isRed(six.data, (10 * 40 + 5) * 4) && isBlue(six.data, (10 * 40 + 35) * 4));
const three = await decodeJpeg(withOrientation(plain, 3));
check("canvas fallback: an EXIF 3 photo isn't turned over", isRed(three.data, (2 * 40 + 2) * 4) && isBlue(three.data, (17 * 40 + 37) * 4));
turnAnyway = true;
const refused = await decodeJpeg(plain).then(() => null, (err: Error) => err);
check("canvas fallback: pixels in another shape than stored are refused, not squashed", refused instanceof Error);
turnAnyway = false;

// --- JPG to PDF with the canvas fallback --------------------------------------
// 4000 x 2000 stored, shown portrait (red on top). On A4 it is stored at 300 DPI
// sideways, 3508 x 1754, red still on the left of the stored picture.
const photo = withOrientation(new Uint8Array(await encodeWasm(redBlue(4000, 2000) as ImageData, { quality: 92 })), 6);
const file = new File([photo.slice() as unknown as BlobPart], "phone.jpg", { type: "image/jpeg" });
const pdf = await PDFDocument.load(await (await imagesToPdfTool([file], { pageSize: "a4", margin: "0" })).blob.arrayBuffer());
const stored = pdf.context
  .enumerateIndirectObjects()
  .map(([, o]) => o)
  .find((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))!;
const back = await decodeWasm(stored.contents.slice().buffer as ArrayBuffer, { preserveOrientation: false });
check("jpg-to-pdf (canvas fallback): the photo is scaled down in its stored shape", back.width === 3508 && back.height === 1754, [back.width, back.height]);
check(
  "jpg-to-pdf (canvas fallback): and not turned (red left, blue right as stored)",
  isRed(back.data, (400 * back.width + 877) * 4) && isBlue(back.data, (400 * back.width + 2631) * 4) && isRed(back.data, (1400 * back.width + 877) * 4)
);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
