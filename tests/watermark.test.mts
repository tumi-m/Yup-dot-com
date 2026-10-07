/**
 * The "Made with PDF Wizard" mark on Free files: PDF (pdf-lib text, checked
 * with pdf.js on rotated pages and boxes that don't start at 0,0) and PPTX
 * (one text box per slide through the lossless package ops).
 */
process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||= "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { PDFDict, PDFDocument, PDFName, StandardFonts, degrees } from "pdf-lib";
import { bakeAnnotations } from "../lib/pdf/bake.ts";
import { watermarkPdf } from "../lib/pdf/watermark.ts";
import { WATERMARK_TEXT } from "../lib/edit-usage.ts";
import { addWatermark, getSlideTexts, openDeck, saveDeck, WATERMARK_SHAPE_NAME } from "../lib/pptx/package.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra?: unknown) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? "  — " + JSON.stringify(extra) : ""}`);
};

/** Text items in displayed (viewport) coordinates, y from the top. */
async function displayedText(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items as { str: string; transform: number[]; height: number }[])
      .filter((t) => t.str.trim())
      .map((t) => {
        const [x, y] = vp.convertToViewportPoint(t.transform[4], t.transform[5]);
        const [x2, y2] = vp.convertToViewportPoint(t.transform[4] + t.transform[0], t.transform[5] + t.transform[1]);
        const size = Math.hypot(t.transform[0], t.transform[1]);
        return { str: t.str, x, y, size, upright: x2 > x && Math.abs(y2 - y) < 0.01 * Math.abs(x2 - x) + 0.01 };
      });
    pages.push({ w: vp.width, h: vp.height, items });
  }
  doc.destroy();
  return pages;
}

// ---------- PDF ----------
const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
const shapes: { size: [number, number]; rotate: number; crop?: [number, number, number, number] }[] = [
  { size: [595, 842], rotate: 0 },
  { size: [595, 842], rotate: 90 },
  { size: [842, 595], rotate: 180 },
  { size: [612, 792], rotate: 270 },
  { size: [700, 900], rotate: 0, crop: [100, 150, 400, 500] },
  { size: [700, 900], rotate: 90, crop: [100, 150, 400, 500] },
];
for (const s of shapes) {
  const p = src.addPage(s.size);
  p.drawText("Body text", { x: 60, y: s.size[1] / 2, size: 12, font });
  if (s.crop) {
    p.setMediaBox(0, 0, s.size[0], s.size[1]);
    p.setCropBox(...s.crop);
    p.drawText("Body text", { x: s.crop[0] + 20, y: s.crop[1] + 200, size: 12, font });
  }
  p.setRotation(degrees(s.rotate));
}
const original = await src.save();

const marked = await watermarkPdf(original);
const pages = await displayedText(marked);
pages.forEach((p, i) => {
  const mark = p.items.filter((t) => t.str === WATERMARK_TEXT);
  const m = mark[0];
  const s = shapes[i];
  const label = `pdf page ${i + 1} (rotate ${s.rotate}${s.crop ? ", cropped box" : ""})`;
  check(`${label}: one mark`, mark.length === 1, p.items.map((t) => t.str));
  if (!m) return;
  const textW = font.widthOfTextAtSize(WATERMARK_TEXT, m.size);
  check(`${label}: upright, bottom-right, inside the page`,
    m.upright && m.x > p.w / 2 && m.x + textW <= p.w - 5 && m.x + textW >= p.w - 15 && m.y <= p.h - 5 && m.y >= p.h - 15,
    { x: m.x, y: m.y, w: p.w, h: p.h, textW });
  check(`${label}: about 8pt`, Math.abs(m.size - 8) < 0.01, m.size);
});
{
  // The page's graphics states: one with fill opacity 0.6 (the mark's).
  const doc = await PDFDocument.load(marked);
  const opacities = doc.getPages().map((p) => {
    const gs = p.node.Resources()?.lookup(PDFName.of("ExtGState"), PDFDict);
    return gs ? gs.values().map((v) => String((doc.context.lookup(v) as PDFDict).get(PDFName.of("ca")))) : [];
  });
  check("pdf: drawn at 60% opacity", opacities.every((o) => o.includes("0.6")), opacities);
}
check("pdf: body text untouched", pages.every((p) => p.items.some((t) => t.str === "Body text")));

const twice = await watermarkPdf(marked);
check("pdf: marking again never stacks", (await displayedText(twice)).every((p) => p.items.filter((t) => t.str === WATERMARK_TEXT).length === 1));
const bakedFree = await bakeAnnotations(original, [], { watermark: true });
const bakedTwice = await bakeAnnotations(bakedFree, [], { watermark: true });
check("bake: Free save then download, still one mark per page",
  (await displayedText(bakedTwice)).every((p) => p.items.filter((t) => t.str === WATERMARK_TEXT).length === 1));
const bakedPro = await bakeAnnotations(original, []);
check("bake: Pro output has no mark", (await displayedText(bakedPro)).every((p) => !p.items.some((t) => t.str === WATERMARK_TEXT)));

// ---------- PPTX ----------
const here = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "pptx-mark-"));
execFileSync("python3", [join(here, "fixtures/make_pptx_fixtures.py"), work], { stdio: "pipe" });
for (const name of ["rich.pptx", "plain.pptx"]) {
  const bytes = new Uint8Array(readFileSync(join(work, name)));
  const before = await openDeck(bytes.slice());
  const n = before.slideCount;
  const textsBefore = Array.from({ length: n }, (_, i) => JSON.stringify(getSlideTexts(before, i)));
  const deck = await openDeck(bytes.slice());
  const added = addWatermark(deck, WATERMARK_TEXT);
  const out = await saveDeck(deck);
  const again = await openDeck(out);
  check(`${name}: a mark on every slide`, added === n && again.slideCount === n);
  let ok = true;
  for (let i = 0; i < n; i++) {
    const t = getSlideTexts(again, i);
    const marks = t.filter((s) => s.name === WATERMARK_SHAPE_NAME);
    const rest = t.filter((s) => s.name !== WATERMARK_SHAPE_NAME);
    if (marks.length !== 1 || marks[0].paragraphs.join() !== WATERMARK_TEXT || JSON.stringify(rest) !== textsBefore[i]) ok = false;
  }
  check(`${name}: slide text otherwise unchanged`, ok);
  check(`${name}: marking again adds nothing`, addWatermark(again, WATERMARK_TEXT) === 0);

  // Only slide parts change; everything else is byte-identical.
  const za = await JSZip.loadAsync(bytes);
  const zb = await JSZip.loadAsync(out);
  const changed: string[] = [];
  for (const f of Object.keys(za.files)) {
    if (za.files[f].dir) continue;
    const a = await za.files[f].async("uint8array");
    const b = await zb.file(f)?.async("uint8array");
    if (!b || a.length !== b.length || a.some((v, k) => v !== b[k])) changed.push(f);
  }
  check(`${name}: only slide XML changed`, changed.length > 0 && changed.every((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f)), changed);

  // python-pptx reads it: one watermark box per slide, bottom-right, 8pt.
  const outPath = join(work, `marked-${name}`);
  writeFileSync(outPath, out);
  const py = `
import sys, json
from pptx import Presentation
p = Presentation(sys.argv[1])
W, H = p.slide_width, p.slide_height
res = []
for s in p.slides:
    m = [sh for sh in s.shapes if sh.name == ${JSON.stringify(WATERMARK_SHAPE_NAME)}]
    if len(m) != 1:
        res.append(False); continue
    sh = m[0]
    r = sh.text_frame.paragraphs[0].runs[0]
    res.append(sh.text_frame.text == ${JSON.stringify(WATERMARK_TEXT)} and r.font.size.pt == 8
      and sh.left + sh.width <= W and sh.top + sh.height <= H and sh.left > W / 2 and sh.top > H / 2)
print(json.dumps(res))
`;
  const verdict = JSON.parse(execFileSync("python3", ["-c", py, outPath]).toString());
  check(`${name}: python-pptx sees one 8pt box, bottom-right, per slide`, verdict.length === n && verdict.every(Boolean), verdict);
}
rmSync(work, { recursive: true, force: true });

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
