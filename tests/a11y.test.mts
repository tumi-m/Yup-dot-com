import { PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { detectFormFields } from "../lib/pdf/forms.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// Form fields are named by their /TU tooltip, as tax and government forms are built.
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const first = form.createTextField("topmostSubform[0].Page1[0].f1_01[0]");
  first.addToPage(page, { x: 50, y: 680, width: 250, height: 22 });
  first.acroField.dict.set(PDFName.of("TU"), PDFString.of("Your first name and middle initial"));
  const agree = form.createCheckBox("c1_1[0]");
  agree.addToPage(page, { x: 50, y: 640, width: 16, height: 16 });
  agree.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText("I agree to the terms"));
  const child = form.createTextField("address.street");
  child.addToPage(page, { x: 50, y: 600, width: 250, height: 22 });
  child.acroField.getParent()!.dict.set(PDFName.of("TU"), PDFString.of("Home address"));
  const plain = form.createTextField("zip");
  plain.addToPage(page, { x: 50, y: 560, width: 80, height: 22 });
  const blank = form.createTextField("blank");
  blank.addToPage(page, { x: 50, y: 520, width: 80, height: 22 });
  blank.acroField.dict.set(PDFName.of("TU"), PDFString.of("   "));
  const fields = await detectFormFields(await doc.save());
  const by = (name: string) => fields.find((f) => f.name === name);
  check("a text field takes its /TU as its label", by("topmostSubform[0].Page1[0].f1_01[0]")?.label === "Your first name and middle initial", by("topmostSubform[0].Page1[0].f1_01[0]"));
  check("a hex-string /TU is decoded", by("c1_1[0]")?.label === "I agree to the terms", by("c1_1[0]"));
  check("a field without /TU uses its parent's", by("address.street")?.label === "Home address", by("address.street"));
  check("no /TU leaves the label empty (the name is used)", by("zip")?.label === undefined, by("zip"));
  check("a blank /TU is ignored", by("blank")?.label === undefined, by("blank"));
}

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
