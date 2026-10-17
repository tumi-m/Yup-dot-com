import { PDFDocument, PDFName, PDFNumber, PDFPageTree, PDFRef, StandardFonts } from "pdf-lib";
import { deletePages, mergePdfs, reorderPages } from "../lib/pdf/operations.ts";
import { detectFormFields, fillFormFields } from "../lib/pdf/forms.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

// A two-page fillable form: name + agree on page 1, notes on page 2, and
// initials with a widget on each page.
const d = await PDFDocument.create();
const font = await d.embedFont(StandardFonts.Helvetica);
const p1 = d.addPage([612, 792]);
const p2 = d.addPage([612, 792]);
p2.drawText("Second page secret", { x: 50, y: 700, size: 20, font });
const f = d.getForm();
f.createTextField("name").addToPage(p1, { x: 50, y: 700, width: 200, height: 20 });
f.createCheckBox("agree").addToPage(p1, { x: 50, y: 650, width: 16, height: 16 });
f.createTextField("notes").addToPage(p2, { x: 50, y: 600, width: 200, height: 20 });
const initials = f.createTextField("initials");
initials.addToPage(p1, { x: 400, y: 50, width: 60, height: 20 });
initials.addToPage(p2, { x: 400, y: 50, width: 60, height: 20 });
// What the editor does before a page operation: write typed values in.
const src = await fillFormFields(await d.save(), { name: "Jane" });

const summary = async (bytes: Uint8Array) => {
  const doc = await PDFDocument.load(bytes);
  const fields = await detectFormFields(bytes);
  const pageObjects = doc.context
    .enumerateIndirectObjects()
    .filter(([, o]) => (o as { get?: (k: PDFName) => unknown }).get?.(PDFName.of("Type")) === PDFName.of("Page")).length;
  return {
    pages: doc.getPageCount(),
    pageObjects,
    acroForm: !!doc.catalog.get(PDFName.of("AcroForm")),
    fields: fields.map((x) => `${x.name}@${x.page}`).sort(),
    names: doc.getForm().getFields().map((x) => x.getName()).sort(),
    name: doc.getForm().getTextField("name").getText(),
  };
};

const del = await summary(await deletePages(src, [1]));
check("delete keeps the form", del.acroForm && del.name === "Jane", del);
check("delete keeps fields on kept pages", del.fields.join() === "agree@0,initials@0,name@0", del.fields);
check("delete drops fields only on the deleted page", del.names.join() === "agree,initials,name", del.names);
check("delete leaves no page object behind", del.pages === 1 && del.pageObjects === 1, del);

const reo = await summary(await reorderPages(src, [1, 0]));
check("reorder keeps the form", reo.acroForm && reo.name === "Jane", reo);
check("reorder moves fields with their pages", reo.fields.join() === "agree@1,initials@0,initials@1,name@1,notes@0", reo.fields);

// The second file has its own form, with a clashing name.
const o = await PDFDocument.create();
const op = o.addPage([612, 792]);
o.getForm().createTextField("name").addToPage(op, { x: 50, y: 700, width: 200, height: 20 });
o.getForm().createTextField("city").addToPage(op, { x: 50, y: 650, width: 200, height: 20 });
const other = await fillFormFields(await o.save(), { name: "Sam", city: "Durban" });
const mergedBytes = await mergePdfs([src, other]);
const mer = await summary(mergedBytes);
check("merge keeps the first file's form", mer.acroForm && mer.name === "Jane", mer);
check(
  "merge brings the second file's fields, renaming clashes",
  mer.fields.join() === "agree@0,city@2,initials@0,initials@1,name@0,name_2@2,notes@1",
  mer.fields
);
const merged = await PDFDocument.load(mergedBytes);
check("merged field keeps its value", merged.getForm().getTextField("name_2").getText() === "Sam");
check("merge leaves no stray page copies", mer.pages === 3 && mer.pageObjects === 3, mer);
const refilled = await PDFDocument.load(await fillFormFields(mergedBytes, { city: "Cape Town", name_2: "Lee" }));
check(
  "merged fields can be filled",
  refilled.getForm().getTextField("city").getText() === "Cape Town" &&
    refilled.getForm().getTextField("name_2").getText() === "Lee"
);

// Plain documents still work, and pages that inherit their size and rotation
// from the page tree keep them when they move.
const n = await PDFDocument.create();
const a = n.addPage([300, 400]);
const b = n.addPage([300, 400]);
const pagesRef = n.catalog.get(PDFName.of("Pages")) as PDFRef;
const mid = PDFPageTree.withContext(n.context, pagesRef);
const midRef = n.context.register(mid);
for (const page of [a, b]) {
  page.node.delete(PDFName.of("MediaBox"));
  mid.pushLeafNode(page.ref);
  page.node.setParent(midRef);
}
mid.set(PDFName.of("MediaBox"), n.context.obj([0, 0, 300, 400]));
mid.set(PDFName.of("Rotate"), PDFNumber.of(90));
const root = n.catalog.Pages();
root.set(PDFName.of("Kids"), n.context.obj([midRef]));
const nested = await n.save();
const moved = await PDFDocument.load(await reorderPages(nested, [1, 0]));
check(
  "moved pages keep inherited size and rotation",
  moved.getPages().every((p) => p.getWidth() === 300 && p.getHeight() === 400 && p.getRotation().angle === 90),
  moved.getPages().map((p) => [p.getWidth(), p.getHeight(), p.getRotation().angle])
);
const left = await PDFDocument.load(await deletePages(nested, [0]));
check("delete on a nested page tree", left.getPageCount() === 1 && left.getPage(0).getRotation().angle === 90);
check("no form is added to a plain document", !left.catalog.get(PDFName.of("AcroForm")));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
