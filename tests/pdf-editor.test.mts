import { PDFDocument } from "pdf-lib";
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

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
