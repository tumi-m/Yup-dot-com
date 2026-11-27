// A phone photo's EXIF (where it was taken, the phone, when), XMP, IPTC and
// comments stay out of the PDF made from it: JPG to PDF and a picture placed
// in Edit PDF copied the JPEG in whole, so a PDF sent round carried the
// photo's GPS position. Its turn (EXIF orientation) is still applied, and the
// colour profile stays.
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const codec = await import("../lib/image-codec.ts");
const wasm = "./node_modules/@jsquash/jpeg/codec/";
await codec.useJpegWasm({
  encoder: await WebAssembly.compile(readFileSync(wasm + "enc/mozjpeg_enc.wasm")),
  decoder: await WebAssembly.compile(readFileSync(wasm + "dec/mozjpeg_dec.wasm")),
});
const { imagesToPdf } = await import("../lib/pdf/images-to-pdf/index.ts");
const { bakeAnnotations } = await import("../lib/pdf/bake.ts");

const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
const ascii = (s: string) => [...Buffer.from(s, "latin1")];

/** A 300 x 200 photo as a phone writes it: EXIF (orientation 6, the phone's make), XMP, IPTC, a comment and a colour profile. */
async function phonePhoto(): Promise<Uint8Array> {
  const pixels = new Uint8ClampedArray(300 * 200 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([(i / 4) % 300, 120, 200, 255], i);
  const jpeg = await codec.encodeJpeg({ data: pixels, width: 300, height: 200 }, { quality: 90 });
  // Big-endian TIFF: orientation 6 and Make "SecretPhone".
  const make = ascii("SecretPhone\0");
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x01, 0x0f, 0, 2, 0, 0, 0, make.length, 0, 0, 0, 38, 0, 0, 0, 0, ...make];
  const exif = segment(0xe1, [...ascii("Exif\0\0"), ...tiff]);
  const xmp = segment(0xe1, ascii("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>26,12.3S</exif:GPSLatitude></x:xmpmeta>"));
  const iptc = segment(0xed, ascii("Photoshop 3.0\0By-line: Lerato"));
  const comment = segment(0xfe, ascii("Taken at 12 Hidden Lane"));
  const icc = segment(0xe2, ascii("ICC_PROFILE\0\x01\x01profile-bytes"));
  return new Uint8Array([...jpeg.subarray(0, 2), ...exif, ...xmp, ...iptc, ...comment, ...icc, ...jpeg.subarray(2)]);
}

const photo = await phonePhoto();
const LEAKS = ["SecretPhone", "Exif", "GPSLatitude", "By-line", "Hidden Lane"];
const leaks = (pdf: Uint8Array) => LEAKS.filter((s) => Buffer.from(pdf).includes(s));

function imageStreams(doc: PDFDocument): Buffer[] {
  return doc.context
    .enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
    .map((o) => Buffer.from(o.contents));
}

// JPG to PDF.
const file = new File([photo.slice() as unknown as BlobPart], "IMG_2041.jpg", { type: "image/jpeg" });
const made = await imagesToPdf([file], { pageSize: "fit", margin: "0" });
check("JPG to PDF: no EXIF, XMP, IPTC or comment in the PDF", leaks(made).length === 0, leaks(made));
const doc = await PDFDocument.load(made);
const { width, height } = doc.getPage(0).getSize();
check("JPG to PDF: the photo is still turned upright (a portrait page)", height > width, { width, height });
const stored = imageStreams(doc)[0];
check("JPG to PDF: the colour profile stays", !!stored && stored.includes("ICC_PROFILE"));
check("JPG to PDF: the picture is the photo's own data, not re-encoded", !!stored && stored.includes(Buffer.from(photo.subarray(photo.length - 200))));

// A photo placed in Edit PDF.
const base = await PDFDocument.create();
base.addPage([600, 800]);
const baked = await bakeAnnotations(await base.save(), [
  { id: "p", page: 0, type: "image", x: 100, y: 100, width: 200, height: 300, dataUrl: `data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}`, signature: false },
]);
check("Edit PDF: no EXIF, XMP, IPTC or comment in the PDF", leaks(baked).length === 0, leaks(baked));

check("withoutMetadata leaves a JPEG with none as it is", codec.withoutMetadata(photo.subarray(0, 2)).length === 2 && (() => {
  const plain = codec.withoutMetadata(photo);
  return codec.withoutMetadata(plain) === plain;
})());

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll photo metadata checks passed");
