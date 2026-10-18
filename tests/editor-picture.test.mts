// Edit PDF's Image tool: the file dialog's JPG/PNG filter is only a hint, and
// "All files" let a WebP, GIF or HEIC through. It showed on the page, then the
// downloaded PDF quietly came without it, while the editor said "Downloaded."
import { PDFDocument } from "pdf-lib";
import { PICTURE_MESSAGE, pictureDataUrl } from "../lib/editor/picture.ts";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import type { ImageAnnotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
const decode = (url: string) => new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// A 1x1 grey PNG, and a PNG-signed file large enough to be encoded in several pieces.
const png = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAWk1v8QAAAABJRU5ErkJggg==", "base64")
);
const big = new Uint8Array(200_000).map((_, i) => (i * 31) & 0xff);
big.set(png.subarray(0, 8));
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
// What ffmpeg writes for a WebP (RIFF....WEBPVP8 ).
const webp = Uint8Array.from([...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WEBPVP8 "), 0x18, 0, 0, 0]);

const pngUrl = await pictureDataUrl(new Blob([png]));
check("a PNG is placed as it is", pngUrl.startsWith("data:image/png;base64,") && same(decode(pngUrl), png), pngUrl.slice(0, 40));
const bigUrl = await pictureDataUrl(new Blob([big]));
check("a large file comes through whole", same(decode(bigUrl), big));
const jpegUrl = await pictureDataUrl(new File([jpeg], "photo.jpg", { type: "" }));
check("a JPEG is placed as it is, whatever type the browser gave it", jpegUrl.startsWith("data:image/jpeg;base64,") && same(decode(jpegUrl), jpeg));
check(
  "a picture the browser can't open as JPEG or PNG says what to use",
  (await failure(() => pictureDataUrl(new File([webp], "pic.webp", { type: "image/webp" })))) === PICTURE_MESSAGE,
  PICTURE_MESSAGE
);

// An image a PDF can't take is said on export, not left out.
const doc = await PDFDocument.create();
doc.addPage([300, 300]);
doc.addPage([300, 300]);
const pdf = await doc.save();
const image = (dataUrl: string, page: number): ImageAnnotation => ({
  id: `img-${page}`,
  type: "image",
  page,
  x: 50,
  y: 50,
  width: 100,
  height: 100,
  dataUrl,
  signature: false,
});
const images = (bytes: Uint8Array) => (Buffer.from(bytes).toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;

const withPng = await bakeAnnotations(pdf, [image(pngUrl, 0)]);
check("a PNG goes into the PDF", images(withPng) === 1, images(withPng));
const webpUrl = `data:image/webp;base64,${Buffer.from(webp).toString("base64")}`;
const message = await failure(() => bakeAnnotations(pdf, [image(pngUrl, 0), image(webpUrl, 1)]));
check(
  "a WebP on page 2 stops the export and says so",
  message === "Couldn't add the image on page 2. Use a JPG or PNG image.",
  message
);

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
