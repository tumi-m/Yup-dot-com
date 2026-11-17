process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseDocument, toPlainText, toMarkdown } from "../lib/pdf/parse.ts";

/**
 * What was typed or ticked in a form is part of the text: the page holds only
 * the labels, and the viewer draws the values from the form fields.
 */
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

const d = await PDFDocument.create();
const p = d.addPage([600, 800]);
const font = await d.embedFont(StandardFonts.Helvetica);
const form = d.getForm();
p.drawText("Application", { x: 50, y: 750, size: 20, font });
p.drawText("Name:", { x: 50, y: 700, size: 12, font });
const name = form.createTextField("name");
name.setText("Thandiwe Nkosi");
name.addToPage(p, { x: 100, y: 690, width: 200, height: 20 });
p.drawText("I agree to the terms", { x: 50, y: 650, size: 12, font });
const agree = form.createCheckBox("agree");
agree.addToPage(p, { x: 180, y: 649, width: 12, height: 12 });
agree.check();
p.drawText("Send me news", { x: 50, y: 610, size: 12, font });
form.createCheckBox("news").addToPage(p, { x: 180, y: 609, width: 12, height: 12 });
p.drawText("City:", { x: 50, y: 570, size: 12, font });
const city = form.createDropdown("city");
city.addOptions(["Durban", "Soweto"]);
city.select("Soweto");
city.addToPage(p, { x: 100, y: 562, width: 120, height: 20 });
p.drawText("Delivery:", { x: 50, y: 530, size: 12, font });
const delivery = form.createRadioGroup("delivery");
delivery.addOptionToPage("post", p, { x: 110, y: 529, width: 12, height: 12 });
p.drawText("Post", { x: 126, y: 530, size: 12, font });
delivery.addOptionToPage("courier", p, { x: 170, y: 529, width: 12, height: 12 });
p.drawText("Courier", { x: 186, y: 530, size: 12, font });
delivery.select("courier");
p.drawText("PIN:", { x: 50, y: 490, size: 12, font });
const pin = form.createTextField("pin");
pin.setText("4321");
pin.enablePassword();
pin.addToPage(p, { x: 100, y: 482, width: 80, height: 20 });

const doc = await parseDocument(await d.save());
const text = toPlainText(doc);
console.log(text);
check("a text field's value follows its label", text.includes("Name: Thandiwe Nkosi"));
check("a ticked box follows its caption", text.includes("I agree to the terms ☒"));
check("an empty box adds nothing", /Send me news\s*\n/.test(text) && (text.match(/☒/g) ?? []).length === 1);
check("a list's choice follows its label", text.includes("City: Soweto"));
check("only the chosen option is marked", text.includes("Delivery: Post ◉ Courier") && (text.match(/◉/g) ?? []).length === 1);
check("a password is left out", text.includes("PIN:") && !text.includes("4321"));
check("the values are not headings", !/^#+ .*(Thandiwe|Soweto)/m.test(toMarkdown(doc)));

process.exit(failed ? 1 : 0);
