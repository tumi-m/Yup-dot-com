import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { drawFields } from "../lib/pdf/forms.ts";

/**
 * A multi-line field sized automatically (/DA "0 Tf", as Acrobat makes a
 * comments or address box) is drawn small enough for all its lines to fit,
 * at most 12 pt, and stays automatic. pdf-lib grew the text until it ran out
 * of height: "My" and "Polokwane." showed, the rest was cut off, and the
 * size it picked was written into the field for good.
 */
let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]);
const form = doc.getForm();
const reason = form.createTextField("reason");
reason.enableMultiline();
reason.addToPage(page, { x: 200, y: 400, width: 300, height: 80 });
reason.acroField.setDefaultAppearance("/Helv 0 Tf 0 g");
const fixed = form.createTextField("notes");
fixed.enableMultiline();
fixed.addToPage(page, { x: 200, y: 200, width: 300, height: 80 });
fixed.acroField.setDefaultAppearance("/Helv 10 Tf 0 g");
const saved = await doc.save({ updateFieldAppearances: false });

const filled = await PDFDocument.load(saved);
const f = filled.getForm();
const text = "My mother is in hospital in Polokwane.\nBack on Monday. Phone my manager, Sipho, on 082 555 0199 if anything is urgent.";
f.getTextField("reason").setText(text);
f.getTextField("notes").setText("Short note.");
await drawFields(f, await filled.embedFont(StandardFonts.Helvetica), null);
const out = await PDFDocument.load(await filled.save({ updateFieldAppearances: false }));

/** The words a field's picture draws, and the size it draws them at. */
function picture(name: string) {
  const field = out.getForm().getTextField(name);
  const ap = field.acroField.getWidgets()[0].dict.lookup(PDFName.of("AP"), PDFDict);
  const stream = ap.lookup(PDFName.of("N"), PDFStream);
  const ops = new TextDecoder().decode(stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents());
  const size = Number(/(\d*\.?\d+) Tf/.exec(ops)?.[1]);
  const words = [...ops.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1")).join(" ");
  // Each line's baseline, from the bottom of the box.
  const lines = [...ops.matchAll(/1 0 0 1 [\d.]+ (-?[\d.]+) Tm/g)].map((m) => Number(m[1]));
  return { size, words, lines, da: field.acroField.getDefaultAppearance() };
}

const auto = picture("reason");
check("every line of the reason is drawn", auto.words.includes("My mother is in hospital") && auto.words.includes("if anything is urgent."), auto.words);
check("at a size that fits, no larger than 12 pt", auto.size > 4 && auto.size <= 12, auto.size);
check("no line falls below the box", auto.lines.length === 3 && auto.lines.every((y) => y >= 2), auto.lines);
check("the field stays sized automatically", /\b0 Tf/.test(auto.da ?? ""), auto.da);
const set = picture("notes");
check("a field with its own size keeps it", set.size === 10 && /10 Tf/.test(set.da ?? ""), set);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll multi-line field checks passed");
