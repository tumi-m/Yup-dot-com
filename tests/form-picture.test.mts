// A form value Helvetica can't draw (Cyrillic, Greek, Arabic) is drawn as a
// picture of the text in that field's own appearance. It used to switch on
// NeedAppearances for the whole form instead: poppler then redrew every
// field, left the Cyrillic value blank and turned an unrelated tick into a
// stray glyph, and Flatten left the field fillable.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { crc32, deflateSync } from "node:zlib";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, PDFString, StandardFonts, degrees } from "pdf-lib";
import { drawFields, type TextPainter } from "../lib/pdf/forms.ts";
import { flattenPdf } from "../lib/pdf/flatten/index.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

/** A 2x2 black PNG: what the browser's canvas would hand back. */
function png(): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 255]);
  return new Uint8Array(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
  );
}

const calls: { text: string; size: number; color: string; maxHeight?: number }[] = [];
const paint: TextPainter = async (text, size, color, _bold, _maxWidth, maxHeight) => {
  calls.push({ text, size, color, maxHeight });
  return { png: png(), width: Math.min(150, text.length * size * 0.5), height: size * 1.2 };
};

async function build() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const name = form.createTextField("name");
  name.addToPage(page, { x: 40, y: 330, width: 200, height: 24 });
  name.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 10 Tf 0 0 1 rg"));
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.addToPage(page, { x: 40, y: 250, width: 200, height: 60 });
  notes.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
  const agree = form.createCheckBox("agree");
  agree.addToPage(page, { x: 40, y: 220, width: 16, height: 16 });
  agree.check();
  const city = form.createDropdown("city");
  city.addOptions(["Cape Town", "Москва"]);
  city.addToPage(page, { x: 40, y: 180, width: 200, height: 24 });
  const side = form.createTextField("side");
  side.addToPage(page, { x: 300, y: 100, width: 14, height: 200 });
  side.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
  side.acroField.getWidgets()[0].getOrCreateAppearanceCharacteristics().setRotation(90);
  return doc.save({ updateFieldAppearances: false });
}

const fill = async (paintWith?: TextPainter | null) => {
  const doc = await PDFDocument.load(await build());
  const form = doc.getForm();
  form.getTextField("name").setText("Дмитрий");
  form.getTextField("notes").setText("Ελένη\nline two");
  form.getDropdown("city").select("Москва");
  form.getTextField("side").setText("Привет");
  await drawFields(form, await doc.embedFont(StandardFonts.Helvetica), paintWith);
  return doc.save({ updateFieldAppearances: false });
};

const bytes = await fill(paint);
const out = await PDFDocument.load(bytes);
const outForm = out.getForm();
const needs = outForm.acroForm.dict.get(PDFName.of("NeedAppearances"));
check("the form doesn't ask readers to redraw every field", needs === undefined, String(needs));
check("the value is kept as typed", outForm.getTextField("name").getText() === "Дмитрий");

const normal = (field: string) => {
  const ap = outForm.getField(field).acroField.getWidgets()[0].dict.lookup(PDFName.of("AP"), PDFDict);
  return ap.lookup(PDFName.of("N"));
};
const content = (field: string) => {
  const n = normal(field);
  return n instanceof PDFRawStream ? Buffer.from(n.contents).toString("latin1") : "";
};
for (const field of ["name", "notes", "city", "side"]) {
  const n = normal(field);
  const im = n instanceof PDFStream ? n.dict.lookup(PDFName.of("Resources"), PDFDict).lookup(PDFName.of("XObject"), PDFDict).get(PDFName.of("Im")) : undefined;
  check(`${field}: its picture shows the value`, n instanceof PDFStream && content(field).includes("/Im Do") && !!im, content(field));
}
check("the text is drawn at the /DA size and colour", calls.some((c) => c.text === "Дмитрий" && c.size === 10 && c.color === "#0000ff"), calls);
const notesRect = outForm.getField("notes").acroField.getWidgets()[0].getRectangle();
check("several lines are kept to the field's height", calls.some((c) => c.text.startsWith("Ελένη") && c.maxHeight === notesRect.height - 4), calls);
check("a dropdown shows its choice", calls.some((c) => c.text === "Москва"));
const sideRect = outForm.getField("side").acroField.getWidgets()[0].getRectangle();
check("a widget turned with /MK /R is drawn turned", content("side").includes(`0 1 -1 0 ${sideRect.width} 0 cm`), content("side"));
check("at a size that fits across it", calls.some((c) => c.text === "Привет" && Math.abs(c.size - Math.min(12, sideRect.width * 0.6)) < 0.01), calls);
const tick = outForm.getCheckBox("agree").acroField.getWidgets()[0].dict.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"));
check("a checkbox keeps its own pictures", tick instanceof PDFDict && tick.has(PDFName.of("Yes")));

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const js = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
const ops = await (await js.getPage(1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
const images = ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length;
check("pdf.js paints the pictures", images >= 4, images);
await js.destroy();

const flat = await flattenPdf(bytes, "forms");
check("flattening paints every field", flat.report.keptFields === 0 && flat.report.fields === 5, flat.report);
check("and leaves no form", !(await PDFDocument.load(flat.bytes)).catalog.has(PDFName.of("AcroForm")));

// Without a canvas (here, or where the picture can't be made) readers are asked to draw it.
const fallback = await PDFDocument.load(await fill(null));
check("with no way to draw it, readers are asked to", String(fallback.getForm().acroForm.dict.get(PDFName.of("NeedAppearances"))) === "true");

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
