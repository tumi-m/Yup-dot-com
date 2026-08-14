import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown } from "pdf-lib";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { detectFormFields, fillFormFields } from "../lib/pdf/forms.ts";
import type { Annotation } from "../lib/editor/types.ts";

// Build a PDF that already contains a form, the way an uploaded document would.
const base = await PDFDocument.create();
base.addPage([595, 842]);
const withForm = await bakeAnnotations(await base.save(), [
  { id: "a", page: 0, type: "field", field: "text", name: "full_name", value: "",
    options: [], fontSize: 12, x: 60, y: 100, width: 200, height: 22 },
  { id: "b", page: 0, type: "field", field: "checkbox", name: "subscribe", value: "",
    options: [], fontSize: 12, x: 60, y: 150, width: 16, height: 16 },
  { id: "c", page: 0, type: "field", field: "dropdown", name: "plan", value: "Free",
    options: ["Free", "Pro", "Team"], fontSize: 12, x: 60, y: 200, width: 140, height: 22 },
] as Annotation[]);

const detected = await detectFormFields(withForm);
console.log(`detected ${detected.length} widget(s):`);
for (const f of detected) {
  console.log(
    `  ${f.name} [${f.kind}] page=${f.page} ` +
      `pos=(${f.x.toFixed(0)}, ${f.y.toFixed(0)}) size=${f.width.toFixed(0)}x${f.height.toFixed(0)} ` +
      `options=[${f.options.join("|")}]`
  );
}

// Top-left origin: a widget drawn at y=100 from the top must report ~100.
const nameField = detected.find((f) => f.name === "full_name");
const originOk = !!nameField && Math.abs(nameField.y - 100) < 2 && Math.abs(nameField.x - 60) < 2;

const filled = await fillFormFields(withForm, {
  full_name: "Ada Lovelace",
  subscribe: "true",
  plan: "Pro",
});

const check = await PDFDocument.load(filled);
const form = check.getForm();
const name = form.getField("full_name") as PDFTextField;
const sub = form.getField("subscribe") as PDFCheckBox;
const plan = form.getField("plan") as PDFDropdown;

const values = {
  full_name: name.getText(),
  subscribe: sub.isChecked(),
  plan: plan.getSelected()[0],
};
console.log("\nafter fill:", JSON.stringify(values));

// Flattening should bake values in and remove the interactive form.
const flat = await fillFormFields(withForm, { full_name: "Flat Value" }, { flatten: true });
const flatCheck = await PDFDocument.load(flat);
const flatFieldCount = flatCheck.getForm().getFields().length;
console.log("fields after flatten:", flatFieldCount);

const ok =
  detected.length === 3 &&
  originOk &&
  values.full_name === "Ada Lovelace" &&
  values.subscribe === true &&
  values.plan === "Pro" &&
  flatFieldCount === 0;

console.log(
  ok
    ? "\nPASS: fields detected with correct top-left geometry, filled, and flattened"
    : `\nFAIL detected=${detected.length} origin=${originOk} values=${JSON.stringify(values)} flat=${flatFieldCount}`
);
process.exit(ok ? 0 : 1);
