import { PDFDocument, PDFName } from "pdf-lib";
import { bakeAnnotations, insertBlankPage, rotatePagesBy } from "../lib/pdf/bake.ts";
import type { Annotation } from "../lib/editor/types.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const base = await PDFDocument.create();
base.addPage([595, 842]);
base.addPage([595, 842]);
const original = await base.save();

const annotations: Annotation[] = [
  { id: "1", page: 0, type: "text", x: 50, y: 50, width: 200, height: 40,
    text: "Hello wizard — wrapped text that should flow onto another line.", fontSize: 12, color: "#111111", bold: false },
  { id: "2", page: 0, type: "draw", x: 50, y: 120, width: 80, height: 40,
    points: [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 80, y: 10 }], color: "#dc2626", strokeWidth: 2 },
  { id: "3", page: 0, type: "image", x: 300, y: 120, width: 60, height: 60, dataUrl: PNG, signature: true },
  { id: "4", page: 0, type: "note", x: 400, y: 60, width: 140, height: 80,
    text: "A sticky note with enough text to wrap across lines.", color: "#fde047" },
  { id: "5", page: 0, type: "shape", shape: "rect", x: 50, y: 200, width: 120, height: 60,
    stroke: "#2563eb", fill: "#93c5fd", strokeWidth: 2, opacity: 0.8 },
  { id: "6", page: 0, type: "shape", shape: "ellipse", x: 200, y: 200, width: 100, height: 60,
    stroke: "#16a34a", fill: null, strokeWidth: 3, opacity: 1 },
  { id: "7", page: 0, type: "shape", shape: "whiteout", x: 50, y: 280, width: 200, height: 20,
    stroke: "#ffffff", fill: "#ffffff", strokeWidth: 1, opacity: 1 },
  { id: "8", page: 0, type: "shape", shape: "arrow", x: 320, y: 200, width: 100, height: 50,
    stroke: "#ea580c", fill: null, strokeWidth: 2, opacity: 1, x1: 320, y1: 200, x2: 420, y2: 250 },
  { id: "9", page: 0, type: "shape", shape: "line", x: 320, y: 280, width: 120, height: 0,
    stroke: "#7c3aed", fill: null, strokeWidth: 1, opacity: 1, x1: 320, y1: 280, x2: 440, y2: 280 },
  { id: "10", page: 0, type: "markup", markup: "highlight", x: 50, y: 320, width: 180, height: 16,
    color: "#fde047", opacity: 0.4 },
  { id: "11", page: 0, type: "markup", markup: "underline", x: 50, y: 350, width: 180, height: 16,
    color: "#dc2626", opacity: 1 },
  { id: "12", page: 0, type: "markup", markup: "strikeout", x: 50, y: 380, width: 180, height: 16,
    color: "#111111", opacity: 1 },
  { id: "13", page: 0, type: "link", x: 50, y: 420, width: 160, height: 18,
    url: "https://example.com", targetPage: null },
  { id: "14", page: 1, type: "link", x: 50, y: 60, width: 160, height: 18, url: "", targetPage: 0 },
  { id: "15", page: 1, type: "field", field: "text", name: "full_name", value: "Ada",
    options: [], fontSize: 12, x: 50, y: 120, width: 180, height: 22 },
  { id: "16", page: 1, type: "field", field: "checkbox", name: "agree", value: "true",
    options: [], fontSize: 12, x: 50, y: 160, width: 16, height: 16 },
  { id: "17", page: 1, type: "field", field: "dropdown", name: "plan", value: "Pro",
    options: ["Free", "Pro", "Team"], fontSize: 12, x: 50, y: 200, width: 120, height: 22 },
  { id: "18", page: 1, type: "field", field: "radio", name: "tier", value: "A",
    options: ["A", "B"], fontSize: 12, x: 50, y: 240, width: 16, height: 16 },
  { id: "19", page: 1, type: "field", field: "radio", name: "tier", value: "B",
    options: ["A", "B"], fontSize: 12, x: 80, y: 240, width: 16, height: 16 },
  // Non-Latin text must not crash the standard-font encoder.
  { id: "20", page: 1, type: "text", x: 50, y: 300, width: 300, height: 20,
    text: "Unicode check: 日本語 — em dash", fontSize: 12, color: "#000000", bold: true },
];

const out = await bakeAnnotations(original, annotations, { watermark: true });
console.log(`baked ok: ${out.length} bytes`);

// Reload and inspect the result.
const check = await PDFDocument.load(out);
const form = check.getForm();
const names = form.getFields().map((f) => f.getName()).sort();
console.log("form fields:", names.join(", "));

const linkCounts = check.getPages().map((p) => {
  const annots = p.node.Annots();
  if (!annots) return 0;
  let n = 0;
  for (let i = 0; i < annots.size(); i++) {
    const d = check.context.lookup(annots.get(i));
    const sub = (d as { get?: (k: unknown) => unknown })?.get?.(PDFName.of("Subtype"));
    if (String(sub) === "/Link") n++;
  }
  return n;
});
console.log("link annotations per page:", linkCounts.join(", "));

// Structural helpers.
const rotated = await rotatePagesBy(out, [0], 90);
const rotCheck = await PDFDocument.load(rotated);
console.log("page 0 rotation after rotate:", rotCheck.getPage(0).getRotation().angle);

const inserted = await insertBlankPage(out, 0);
const insCheck = await PDFDocument.load(inserted);
console.log("page count after insert:", insCheck.getPageCount());

// A field with no widget is invisible in the PDF, so assert widgets too.
const widgetCounts = Object.fromEntries(
  form.getFields().map((f) => [f.getName(), f.acroField.getWidgets().length])
);
console.log("widgets per field:", JSON.stringify(widgetCounts));

const expectFields = ["agree", "full_name", "plan", "tier"];
const fieldsOk =
  expectFields.every((n) => names.includes(n)) &&
  expectFields.every((n) => (widgetCounts[n] ?? 0) >= 1) &&
  widgetCounts["tier"] === 2;
const linksOk = linkCounts[0] >= 1 && linkCounts[1] >= 1;
const pagesOk = insCheck.getPageCount() === 3 && rotCheck.getPage(0).getRotation().angle === 90;

console.log(
  fieldsOk && linksOk && pagesOk
    ? "\nPASS: all annotation types baked; form fields and links survived the round-trip"
    : `\nFAIL fields=${fieldsOk} links=${linksOk} pages=${pagesOk}`
);
process.exit(fieldsOk && linksOk && pagesOk ? 0 : 1);
