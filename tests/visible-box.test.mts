// Stamps land on the part of the page readers show: the CropBox clipped to
// the MediaBox. With a CropBox larger than the MediaBox, page numbers and the
// Free "Made with PDF Wizard" mark used to be placed by the CropBox alone, off
// the visible page, and Edit PDF placed its items out of line with the
// editor.
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { pageNumbersTool, watermarkTool } from "../lib/pdf/toolkit.ts";
import { watermarkPdf } from "../lib/pdf/watermark.ts";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { WATERMARK_TEXT } from "../lib/edit-usage.ts";
import type { Annotation } from "../lib/editor/types.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const file = (bytes: Uint8Array) => new File([bytes.slice() as unknown as BlobPart], "odd.pdf", { type: "application/pdf" });
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

/** Text on page 1 where the reader shows it: from the top-left of the visible page. */
async function shown(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const items = (await page.getTextContent()).items.flatMap((t) => {
    if (!("str" in t) || !t.str.trim()) return [];
    const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
    return [{ str: t.str, x, y, right: x + t.width }];
  });
  await doc.destroy();
  return { w: vp.width, h: vp.height, items };
}
const inside = (t: { x: number; y: number; right: number } | undefined, p: { w: number; h: number }) =>
  !!t && t.x >= 0 && t.right <= p.w + 0.5 && t.y > 0 && t.y <= p.h;

// A Letter page whose CropBox reaches 50 pt past it on every side.
const d = await PDFDocument.create();
const font = await d.embedFont(StandardFonts.Helvetica);
const page = d.addPage([612, 792]);
page.setCropBox(-50, -50, 712, 892);
page.drawText("Body", { x: 100, y: 400, size: 12, font });
const odd = await d.save();

const numbered = await shown(new Uint8Array(await (await pageNumbersTool([file(odd)], { position: "bottom-right", format: "n_of_N", fontSize: "12" })).blob.arrayBuffer()));
check("readers show the MediaBox", numbered.w === 612 && numbered.h === 792, numbered);
const label = numbered.items.find((t) => t.str === "1 of 1");
check("page number is on the visible page, bottom-right", inside(label, numbered) && label!.x > 500 && label!.y > 740, label);

const marked = await shown(new Uint8Array(await (await watermarkTool([file(odd)], { text: "DRAFT", opacity: "0.3", color: "#ff0000", fontSize: "60" })).blob.arrayBuffer()));
const mark = marked.items.find((t) => t.str === "DRAFT");
check("watermark starts inside the visible page", !!mark && mark.x > 0 && mark.x < 306 && mark.y > 396 && mark.y < 792, mark);

const free = await shown(await watermarkPdf(odd));
const madeWith = free.items.find((t) => t.str === WATERMARK_TEXT);
check("the Free mark is on the visible page, bottom-right", inside(madeWith, free) && madeWith!.y > 770, madeWith);

const edited = await shown(
  await bakeAnnotations(odd, [{ id: "t", type: "text", page: 0, x: 20, y: 20, width: 200, height: 20, text: "Signed", fontSize: 14, color: "#000000", bold: false } as Annotation])
);
const signed = edited.items.find((t) => t.str === "Signed");
check("Edit PDF puts text where it was placed", !!signed && Math.abs(signed.x - 20) < 1 && Math.abs(signed.y - 34) < 2, signed);

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
