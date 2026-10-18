// When the MozJPEG wasm can't load, JPEGs are decoded by the browser's canvas.
// Browsers apply EXIF orientation whatever createImageBitmap is told
// (Chromium 141 treats imageOrientation "none" as "from-image"), but a PDF
// viewer draws an image stream as stored. Compress PDF used to re-encode an
// upside-down (orientation 3) photo flipped.
import { readFileSync } from "node:fs";
import encode, { init as initEncode } from "@jsquash/jpeg/encode.js";
import decode, { init as initDecode } from "@jsquash/jpeg/decode.js";
import { decodeJpeg, withoutApp1 } from "../lib/image-codec.ts";

let failed = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
  if (!ok) failed++;
}

const wasm = "./node_modules/@jsquash/jpeg/codec/";
await initEncode(await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")));
await initDecode(await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")));

// 64×64: red on top, blue below, as stored.
const w = 64;
const h = 64;
const rgba = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) rgba.set(i < (w * h) / 2 ? [230, 20, 20, 255] : [20, 20, 230, 255], i * 4);
const plain = new Uint8Array(await encode({ data: rgba, width: w, height: h } as ImageData, { quality: 90 }));

function segment(marker: number, payload: Uint8Array) {
  return new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload]);
}
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
// "Exif\0\0", a big-endian TIFF header and one IFD entry: Orientation (0x0112) = 3, turned 180°.
const exif = segment(0xe1, new Uint8Array([...latin1("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 3, 0, 0, 0, 0, 0, 0]));
const xmp = segment(0xe1, latin1('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"/>'));
const icc = segment(0xe2, latin1("ICC_PROFILE\0\x01\x01"));
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const rotated = join(plain.subarray(0, 2), exif, xmp, icc, plain.subarray(2));

const hasApp1 = (b: Uint8Array) => {
  for (let i = 2; i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda; i += 2 + ((b[i + 2] << 8) | b[i + 3])) {
    if (b[i + 1] === 0xe1) return true;
  }
  return false;
};

// --- withoutApp1 ------------------------------------------------------------
const stripped = withoutApp1(rotated);
check("EXIF and XMP segments removed", hasApp1(rotated) && !hasApp1(stripped));
check("everything else kept", stripped.length === plain.length + icc.length && stripped.subarray(-100).every((v, i) => v === plain[plain.length - 100 + i]));
check("a JPEG without them is handed back as it is", withoutApp1(plain) === plain);
const truncated = rotated.subarray(0, 10);
check("a damaged file is handed back as it is", withoutApp1(truncated) === truncated);
check("not a JPEG: handed back as it is", withoutApp1(latin1("%PDF-1.7")).length === 8);

// --- The canvas fallback ----------------------------------------------------
// Stand-ins for the browser, which applies EXIF orientation whatever it is
// told (the wasm decoder with preserveOrientation does the same).
let bitmapOptions: unknown = "not called";
Object.assign(globalThis, {
  createImageBitmap: async (blob: Blob, options?: unknown) => {
    bitmapOptions = options;
    const img = await decode(await blob.arrayBuffer(), { preserveOrientation: true });
    return { width: img.width, height: img.height, data: img.data, close() {} };
  },
  OffscreenCanvas: class {
    private px = new Uint8ClampedArray(0);
    getContext() {
      return {
        drawImage: (bitmap: { data: Uint8ClampedArray }) => (this.px = bitmap.data),
        getImageData: () => ({ data: this.px }),
      };
    }
  },
});

// The stand-in really does turn it, so the check below means something.
const turned = await decode(rotated.slice().buffer, { preserveOrientation: true });
check("stand-in browser applies the orientation", turned.data[0] < 100 && turned.data[2] > 150, Array.from(turned.data.subarray(0, 3)));

// No wasm here (nothing is served at /vendor), so decodeJpeg uses the canvas.
const out = await decodeJpeg(rotated);
const px = (y: number) => Array.from(out.data.subarray((y * w + w / 2) * 4, (y * w + w / 2) * 4 + 3));
check("canvas fallback was used", bitmapOptions !== "not called");
check("decoded as stored: red on top", px(2)[0] > 150 && px(2)[2] < 100, px(2));
check("decoded as stored: blue below", px(h - 3)[2] > 150 && px(h - 3)[0] < 100, px(h - 3));
check("same size", out.width === w && out.height === h, [out.width, out.height]);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
