// What the editor needs to draw a PDF's own fields as inputs on the page:
// the text size the field asks for, so a value shows at the size it prints,
// and which way it is turned. A field on a /Rotate 90 page used to get a
// font size from its displayed height (the field's length) and showed as a
// black bar.
import { PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream, degrees } from "pdf-lib";
import { detectFormFields, daFontSize, fieldFontSize, fillFormFields } from "../lib/pdf/forms.ts";

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

check("an upright page's fields are not turned", fields.every((f) => f.rotation === 0), fields.map((f) => f.rotation));

// A turned page: one field turns with it, one is drawn upright (/MK /R).
const turned = await PDFDocument.create();
const p2 = turned.addPage([612, 792]);
p2.setRotation(degrees(90));
const tf = turned.getForm();
const along = tf.createTextField("along");
along.addToPage(p2, { x: 150, y: 400, width: 200, height: 14 });
along.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
const upright = tf.createTextField("upright");
upright.addToPage(p2, { x: 300, y: 100, width: 14, height: 200 });
upright.acroField.dict.set(PDFName.of("DA"), PDFString.of("/Helv 0 Tf 0 g"));
upright.acroField.getWidgets()[0].getOrCreateAppearanceCharacteristics().setRotation(90);
const p3 = turned.addPage([612, 792]);
p3.setRotation(degrees(180));
tf.createTextField("flipped").addToPage(p3, { x: 150, y: 400, width: 200, height: 24 });
const turnedFields = await detectFormFields(await turned.save({ updateFieldAppearances: false }));
const t = (name: string) => turnedFields.find((f) => f.name === name)!;
check("a field on a /Rotate 90 page turns a quarter", t("along").rotation === 90, t("along").rotation);
check("its box is tall on screen", t("along").height > t("along").width, t("along"));
check("its text size comes from its own height, not its length", Math.abs(t("along").fontSize - t("along").width * 0.6) < 0.01, t("along"));
check("a field that turns back with /MK /R is upright", t("upright").rotation === 0, t("upright").rotation);
check("and sized by its height on screen", t("upright").height < t("upright").width && Math.abs(t("upright").fontSize - t("upright").height * 0.6) < 0.01, t("upright"));
check("a field on an upside-down page turns half", t("flipped").rotation === 180, t("flipped").rotation);

/** Every stream in a file, decoded, to look for a value drawn into it. */
async function allStreams(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) out += Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
  }
  return out;
}
const showsSecret = (text: string) => text.includes("736563726574") || text.includes("(secret)");

// A password field: PDF forms don't store what is typed in one.
const pw = await PDFDocument.create();
const pwPage = pw.addPage([400, 400]);
const secret = pw.getForm().createTextField("pin");
secret.addToPage(pwPage, { x: 40, y: 330, width: 200, height: 24 });
secret.setText("old");
secret.enablePassword();
pw.getForm().createTextField("name").addToPage(pwPage, { x: 40, y: 290, width: 200, height: 24 });
const pwBytes = await pw.save();
const pwField = (await detectFormFields(pwBytes)).find((f) => f.name === "pin");
check("a password field is marked", pwField?.password === true, pwField);
check("and its stored value isn't shown", pwField?.value === "", pwField?.value);
const pwFilled = await fillFormFields(pwBytes, { pin: "secret", name: "Ada" });
const pwOut = await PDFDocument.load(pwFilled);
check("a typed password is not saved", pwOut.getForm().getTextField("pin").getText() === "old", pwOut.getForm().getTextField("pin").getText());
check("nor drawn into the file", !showsSecret(await allStreams(pwFilled)));
check("other fields are saved", pwOut.getForm().getTextField("name").getText() === "Ada");
check("flattening doesn't print it", !showsSecret(await allStreams(await fillFormFields(pwBytes, { pin: "secret" }, { flatten: true }))));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
