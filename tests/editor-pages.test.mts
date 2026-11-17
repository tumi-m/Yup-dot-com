import { PDFDocument } from "pdf-lib";
import { insertBlankPage, rotatePagesBy } from "../lib/pdf/bake.ts";
import { deletePages, mergePdfs, reorderPages } from "../lib/pdf/operations.ts";
import { detectFormFields } from "../lib/pdf/forms.ts";
import { historyReducer, type HistoryState } from "../lib/editor/history.ts";
import { deleteMap, insertAfterMap, orderMap, pageAfter, remapAnnotations, sameMap } from "../lib/editor/page-map.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const text = (id: string, page: number): Annotation => ({
  id,
  type: "text",
  page,
  x: 10,
  y: 10,
  width: 50,
  height: 20,
  text: id,
  fontSize: 12,
  color: "#000000",
  bold: false,
});
const link = (id: string, page: number, targetPage: number): Annotation => ({
  id,
  type: "link",
  page,
  x: 10,
  y: 10,
  width: 50,
  height: 20,
  url: "",
  targetPage,
});
const pages = (anns: Annotation[]) => anns.map((a) => `${a.id}@${a.page}`).join(" ");

// Page maps
const order = [2, 0, 1];
check("reorder: each page goes where the order puts it", [0, 1, 2].map(orderMap(order)).join() === "1,2,0");
check("delete: pages before stay, the page goes, pages after move up", [0, 1, 2, 3].map(deleteMap(1)).join() === "0,,1,2");
check("insert after: pages after move down", [0, 1, 2].map(insertAfterMap(0)).join() === "0,2,3");
check("merge: pages keep their index", [0, 1, 2].map(sameMap).join() === "0,1,2");

// Annotations follow their pages
const anns = [text("a", 0), text("b", 1), text("c", 2), link("l", 0, 2), link("m", 2, 1)];
check("delete: edits on later pages move up, the page's own go", pages(remapAnnotations(anns, deleteMap(1))) === "a@0 c@1 l@0", pages(remapAnnotations(anns, deleteMap(1))));
const linked = remapAnnotations(anns, deleteMap(1)).find((a) => a.id === "l");
check("delete: a link follows the page it points to", linked?.type === "link" && linked.targetPage === 1, linked);
check("delete: a link to the deleted page goes too", !remapAnnotations(anns, deleteMap(1)).some((a) => a.id === "m"));
check("reorder: edits move with their page", pages(remapAnnotations(anns, orderMap(order))) === "a@1 b@2 c@0 l@1 m@0");
const reLinked = remapAnnotations(anns, orderMap(order)).find((a) => a.id === "l");
check("reorder: a link target moves with the page", reLinked?.type === "link" && reLinked.targetPage === 0, reLinked);
check("nothing moved: the same array back", remapAnnotations(anns, sameMap) === anns);
check("the page shown stays the same page", pageAfter(2, deleteMap(0), 3) === 1 && pageAfter(1, insertAfterMap(0), 4) === 2);
check("the deleted page shown: the next one, or the last", pageAfter(1, deleteMap(1), 2) === 1 && pageAfter(2, deleteMap(2), 2) === 1);

// History keeps its steps through a page operation
{
  type S = HistoryState<Annotation[]>;
  let st: S = { past: [], present: [], future: [], pending: null };
  st = historyReducer(st, { type: "commit", next: [text("a", 0)] });
  st = historyReducer(st, { type: "commit", next: (p) => [...p, text("b", 2)] });
  st = historyReducer(st, { type: "commit", next: (p) => [...p, text("c", 1)] });
  st = historyReducer(st, { type: "undo" });
  st = historyReducer(st, { type: "remap", fn: (v) => remapAnnotations(v, deleteMap(0)) });
  check("remap: the present moves", pages(st.present) === "b@1", st.present);
  check("remap: and the future", st.future.map(pages).join("|") === "b@1 c@0", st.future);
  check("remap: a step whose edits all went with the page is dropped", st.past.length === 1 && st.past[0].length === 0, st.past);
  st = historyReducer(st, { type: "undo" });
  check("remap: undo still goes back", st.present.length === 0 && st.future.length === 2, st);
  st = historyReducer(st, { type: "redo" });
  st = historyReducer(st, { type: "redo" });
  check("remap: redo brings back the edit on its new page", pages(st.present) === "b@1 c@0", st.present);

  // A page operation in the middle of a drag: the drag is still one step.
  let g: S = { past: [], present: [text("a", 1)], future: [], pending: null };
  g = historyReducer(g, { type: "begin" });
  g = historyReducer(g, { type: "remap", fn: (v) => remapAnnotations(v, insertAfterMap(0)) });
  g = historyReducer(g, { type: "end" });
  check("remap: an unchanged gesture records no step", g.past.length === 0 && pages(g.present) === "a@2", g);
}

// The page operations keep the form, so typed values still have their fields.
{
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([612, 792]);
  const p2 = doc.addPage([612, 792]);
  doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("name").addToPage(p1, { x: 50, y: 600, width: 200, height: 30 });
  form.createTextField("city").addToPage(p2, { x: 50, y: 600, width: 200, height: 30 });
  form.createCheckBox("agree").addToPage(p2, { x: 50, y: 500, width: 20, height: 20 });
  const bytes = await doc.save();
  const fields = async (b: Uint8Array) => (await detectFormFields(b)).map((f) => `${f.name}@${f.page}`).join(" ");
  check("rotate keeps the fields", (await fields(await rotatePagesBy(bytes, [1], 90))) === "name@0 city@1 agree@1");
  check("insert keeps the fields", (await fields(await insertBlankPage(bytes, 0))) === "name@0 city@2 agree@2");
  check("reorder keeps the fields", (await fields(await reorderPages(bytes, [2, 1, 0]))) === "name@2 city@1 agree@1");
  check("delete keeps the other pages' fields", (await fields(await deletePages(bytes, [0]))) === "city@0 agree@0");
  check("merge keeps the fields", (await fields(await mergePdfs([bytes, bytes]))).startsWith("name@0 city@1 agree@1"));
}

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
