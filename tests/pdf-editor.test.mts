import { crc32, deflateSync, inflateSync } from "node:zlib";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { detectFormFields, fillFormFields } from "../lib/pdf/forms.ts";
import { createAnnotation, resizeDraft } from "../lib/editor/factory.ts";
import { DEFAULT_SETTINGS, type Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// A form with a 5-character zip code and a multi-line notes box.
const formDoc = await PDFDocument.create();
const formPage = formDoc.addPage([612, 792]);
const zip = formDoc.getForm().createTextField("zip");
zip.setMaxLength(5);
zip.addToPage(formPage, { x: 50, y: 600, width: 200, height: 30 });
const notes = formDoc.getForm().createTextField("notes");
notes.enableMultiline();
notes.addToPage(formPage, { x: 50, y: 400, width: 300, height: 100 });
const formBytes = await formDoc.save();
const detected = await detectFormFields(formBytes);
const textOf = async (bytes: Uint8Array, name: string) =>
  (await PDFDocument.load(bytes)).getForm().getTextField(name).getText();

// Values over a field's MaxLen
check("max length is detected", detected.find((f) => f.name === "zip")?.maxLength === 5, detected);
check("no max length when the field has none", detected.find((f) => f.name === "notes")?.maxLength === undefined);
const long = await fillFormFields(formBytes, { zip: "123456" });
check("a value over max length keeps what fits", (await textOf(long, "zip")) === "12345", await textOf(long, "zip"));

// Multi-line fields
check("multi-line is detected", detected.find((f) => f.name === "notes")?.multiline === true);
check("single-line is not", detected.find((f) => f.name === "zip")?.multiline === false);
const lines = await fillFormFields(formBytes, { notes: "Line 1\nLine 2" });
check("line breaks are kept", (await textOf(lines, "notes")) === "Line 1\nLine 2", await textOf(lines, "notes"));

// Freehand strokes drawn up and to the left keep a box around the whole stroke
let stroke = createAnnotation("draw", DEFAULT_SETTINGS, 400, 400)!;
for (const [x, y] of [[300, 330], [200, 250], [250, 420]]) stroke = resizeDraft(stroke, 400, 400, x, y);
const s = stroke as Extract<Annotation, { type: "draw" }>;
const absolute = s.points.map((p) => [Math.round(s.x + p.x), Math.round(s.y + p.y)]).join(" ");
check("stroke box starts at its top-left point", s.x === 200 && s.y === 250, [s.x, s.y]);
check("stroke box covers the stroke", s.width === 200 && s.height === 170, [s.width, s.height]);
check("stroke points stay where they were drawn", absolute === "400,400 300,330 200,250 250,420", absolute);
check("stroke points sit inside the box", s.points.every((p) => p.x >= 0 && p.y >= 0 && p.x <= s.width && p.y <= s.height));

// Images and signatures keep their aspect ratio in the exported PDF, as on screen
function png(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  const file = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${file.toString("base64")}`;
}
const blank = await PDFDocument.create();
blank.addPage([612, 792]);
const blankBytes = await blank.save();
/** The image placements on page 1 as [x, y, width, height]. */
async function placements(bytes: Uint8Array) {
  const page = (await PDFDocument.load(bytes)).getPage(0);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r)) : [contents];
  const ops = streams
    .map((st) => {
      const raw = st as PDFRawStream;
      const filtered = raw.dict.get(PDFName.of("Filter"));
      return Buffer.from(filtered ? inflateSync(raw.contents) : raw.contents).toString("latin1");
    })
    .join("\n");
  // pdf-lib's drawImage: translate, rotate (none), scale to size, skew (none), draw.
  const re = /1 0 0 1 ([\d.-]+) ([\d.-]+) cm\n1 0 0 1 0 0 cm\n([\d.]+) 0 0 ([\d.]+) 0 0 cm\n1 0 0 1 0 0 cm\n\/Image/g;
  return [...ops.matchAll(re)].map((m) => m.slice(1, 5).map((v) => Math.round(Number(v))));
}
const wide = createAnnotation("image", DEFAULT_SETTINGS, 50, 50, { dataUrl: png(400, 200) })!;
const sig = createAnnotation("signature", DEFAULT_SETTINGS, 50, 300, { dataUrl: png(460, 180) })!;
const placed = await placements(await bakeAnnotations(blankBytes, [wide, sig]));
// Image box 200x150 at (50, 50): a 2:1 image is 200x100, centred. Page height 792.
check("image keeps its aspect ratio", JSON.stringify(placed[0]) === JSON.stringify([50, 792 - 50 - 125, 200, 100]), placed);
// Signature box 160x70 at (50, 300): 460x180 fits as 160x63, centred.
check("signature keeps its aspect ratio", JSON.stringify(placed[1]) === JSON.stringify([50, 792 - 300 - 70 + 4, 160, 63]), placed);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
