// Form values are saved as typed. Values used to be stored with "?" for
// anything outside Latin-1, even the ’ “ ” – — € that phone keyboards type
// and Helvetica can draw; Arabic, Greek and Cyrillic names were lost. A
// dropdown set to a non-Latin option (Łódź) made Save and Download fail
// with "WinAnsi cannot encode".
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { fillFormFields, detectFormFields } from "../lib/pdf/forms.ts";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { friendlyPdfError } from "../lib/pdf/errors.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
async function attempt<T>(work: () => Promise<T>): Promise<T | string> {
  try {
    return await work();
  } catch (err) {
    return friendlyPdfError(err).message;
  }
}
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const needAppearances = (doc: PDFDocument) => String(doc.catalog.getAcroForm()?.dict.get(PDFName.of("NeedAppearances")) ?? "");

const d = await PDFDocument.create();
const page = d.addPage([400, 400]);
const f = d.getForm();
f.createTextField("name").addToPage(page, { x: 40, y: 330, width: 300, height: 24 });
f.createTextField("code").addToPage(page, { x: 40, y: 290, width: 300, height: 24 });
f.getTextField("code").setMaxLength(3);
const city = f.createDropdown("city");
city.addOptions(["Cape Town", "Łódź", "Москва"]);
city.addToPage(page, { x: 40, y: 250, width: 200, height: 24 });
const form = await d.save();

// Punctuation phone keyboards type, all drawable in Helvetica.
const curly = "Don’t — €5 “quoted” O’Brien Žižek";
const filled = await PDFDocument.load(await fillFormFields(form, { name: curly }));
check("curly quotes, dashes and € are stored as typed", filled.getForm().getTextField("name").getText() === curly, filled.getForm().getTextField("name").getText());
check("and drawn by the PDF itself", needAppearances(filled) === "", needAppearances(filled));

// Scripts Helvetica can't draw: the value is kept, readers draw the field.
const names = "Nomvula أحمد Ελένη Дмитрий";
const filledOut = await fillFormFields(form, { name: names, code: "ab😀cd" });
const other = await PDFDocument.load(filledOut);
check("Arabic, Greek and Cyrillic are stored as typed", other.getForm().getTextField("name").getText() === names, other.getForm().getTextField("name").getText());
check("readers are asked to draw what Helvetica can't", needAppearances(other) === "true", needAppearances(other));
check("a length limit never cuts an emoji in half", other.getForm().getTextField("code").getText() === "ab", other.getForm().getTextField("code").getText());
const js = await pdfjs.getDocument({ data: filledOut.slice(), verbosity: 0 }).promise;
const fieldValues = Object.values((await js.getFieldObjects()) ?? {}).flat().map((o) => (o as { value?: unknown }).value);
check("pdf.js reads the value", fieldValues.includes(names), fieldValues);
await js.destroy();
check("the editor shows the value again", (await detectFormFields(filledOut)).find((x) => x.name === "name")?.value === names);

// A dropdown option with a letter outside WinAnsi.
const picked = await attempt(() => fillFormFields(form, { city: "Łódź", name: "Thandiwe" }));
check("choosing Łódź saves", picked instanceof Uint8Array, picked);
if (picked instanceof Uint8Array) {
  const doc = await PDFDocument.load(picked);
  check("and keeps the choice", doc.getForm().getDropdown("city").getSelected()[0] === "Łódź", doc.getForm().getDropdown("city").getSelected());
  check("and the other value", doc.getForm().getTextField("name").getText() === "Thandiwe");
  const again = await attempt(() => fillFormFields(picked, { city: "Москва" }));
  check("a saved file can be filled again", again instanceof Uint8Array, again);
}

// Fields made in the editor.
const blank = await (async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  return doc.save();
})();
const fields: Annotation[] = [
  { id: "a", type: "field", field: "dropdown", page: 0, x: 40, y: 40, width: 200, height: 24, name: "city", value: "Łódź", options: ["Cape Town", "Łódź"], fontSize: 12 } as Annotation,
  { id: "b", type: "field", field: "text", page: 0, x: 40, y: 80, width: 200, height: 24, name: "name", value: "Don’t أحمد", options: [], fontSize: 12 } as Annotation,
  { id: "c", type: "note", page: 0, x: 40, y: 140, width: 200, height: 80, text: "Don’t forget the €5", color: "#fde68a" } as Annotation,
];
const baked = await attempt(() => bakeAnnotations(blank, fields));
check("editor fields with non-Latin values export", baked instanceof Uint8Array, baked);
if (baked instanceof Uint8Array) {
  const doc = await PDFDocument.load(baked);
  check("editor dropdown keeps Łódź", doc.getForm().getDropdown("city").getSelected()[0] === "Łódź");
  check("editor text field keeps its value", doc.getForm().getTextField("name").getText() === "Don’t أحمد", doc.getForm().getTextField("name").getText());
  check("editor fields sit on the page", doc.getForm().getFields().every((x) => x.acroField.getWidgets().every((w) => !!w.P())));
  const text = await pdfjs.getDocument({ data: baked.slice(), verbosity: 0 }).promise.then(async (js) => {
    const items = (await (await js.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : ""));
    await js.destroy();
    return items.join(" ");
  });
  check("a note keeps its ’ and €", text.includes("Don’t forget the €5"), text);
}

const fontError = friendlyPdfError(new Error('WinAnsi cannot encode "Ł" (0x0141)')).message;
check("a font error reads plainly", !/WinAnsi|0x/.test(fontError), fontError);
check("Helvetica can draw what the stored value keeps", (() => {
  try {
    d.embedStandardFont(StandardFonts.Helvetica).encodeText(curly);
    return true;
  } catch {
    return false;
  }
})());

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
