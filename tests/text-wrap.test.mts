// A word wider than its box (a long link) breaks between letters in the
// saved file, as the editor's text box shows it. It used to be drawn whole on
// one line, past the box and off the edge of the page.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument } from "pdf-lib";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const url = "https://example.org/a/very/long/path/without/any/spaces/at/all/to/check/wrapping/index.html";
const blank = await PDFDocument.create();
blank.addPage([400, 600]);
const baked = await bakeAnnotations(await blank.save(), [
  { id: "t", type: "text", page: 0, x: 40, y: 40, width: 180, height: 40, text: `See ${url} now`, fontSize: 14, color: "#000000", bold: false },
  { id: "n", type: "note", page: 0, x: 40, y: 300, width: 150, height: 120, text: url, color: "#fde047" },
] as Annotation[]);

const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const js = await pdfjs.getDocument({ data: baked.slice(), verbosity: 0 }).promise;
const items = (await (await js.getPage(1)).getTextContent()).items.filter((i) => "str" in i && i.str.trim()) as { str: string; width: number; transform: number[] }[];
await js.destroy();

const text = items.filter((i) => i.transform[5] > 400);
const note = items.filter((i) => i.transform[5] < 300 && i.str !== "Note");
const right = (list: typeof items) => Math.max(...list.map((i) => i.transform[4] + i.width));
check("a long link stays inside its text box", right(text) <= 40 + 180 + 0.5, text.map((i) => [i.str, i.transform[4] + i.width]));
check("over several lines", text.length >= 4, text.map((i) => i.str));
check("with nothing lost", text.map((i) => i.str).join("").replace(/\s/g, "") === `See${url}now`, text.map((i) => i.str).join("|"));
check("the word before it keeps its own line", text[0]?.str === "See", text[0]?.str);
check("a long link in a note stays inside the note", right(note) <= 40 + 150 - 5 + 0.5, note.map((i) => [i.str, i.transform[4] + i.width]));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
