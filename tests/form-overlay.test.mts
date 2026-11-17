// What the editor needs to draw a PDF's own fields as inputs on the page:
// the text size the field asks for, so a value shows at the size it prints.
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { detectFormFields, daFontSize, fieldFontSize } from "../lib/pdf/forms.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

check("reads the size from /DA", daFontSize("0 g /Helv 10 Tf") === 10);
check("the last Tf wins", daFontSize("/Helv 8 Tf 0 g /Helv 11.5 Tf") === 11.5);
check("0 Tf means fit the box", daFontSize("/Helv 0 Tf 0 g") === 0);
check("no Tf, no size", daFontSize("0 g") === undefined && daFontSize(undefined) === undefined);
check("auto size fits a short field", fieldFontSize("/Helv 0 Tf", 15) === 9);
check("auto size stops at 12pt", fieldFontSize(undefined, 40) === 12);

const doc = await PDFDocument.create();
const page = doc.addPage([400, 400]);
const form = doc.getForm();
const sized = form.createTextField("sized");
sized.addToPage(page, { x: 40, y: 330, width: 200, height: 24 });
sized.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 9 Tf 0 g"));
const auto = form.createTextField("auto");
auto.addToPage(page, { x: 40, y: 290, width: 200, height: 15 });
auto.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
// A size on the widget beats the field's.
const own = form.createTextField("own");
own.addToPage(page, { x: 40, y: 250, width: 200, height: 24 });
own.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 9 Tf 0 g"));
own.acroField.getWidgets()[0].dict.set(PDFName.of("DA"), PDFString.of("/Helv 14 Tf 0 g"));
const bytes = await doc.save({ updateFieldAppearances: false });

const fields = await detectFormFields(bytes);
const size = (name: string) => fields.find((f) => f.name === name)?.fontSize;
check("a field's /DA size is reported", size("sized") === 9, size("sized"));
const autoField = fields.find((f) => f.name === "auto");
check("a 0 size fits the field's height", !!autoField && Math.abs(autoField.fontSize - autoField.height * 0.6) < 0.01, autoField);
check("a widget's own /DA is used", size("own") === 14, size("own"));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
