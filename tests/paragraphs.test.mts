process.env.NEXT_PUBLIC_PDFJS_WORKER_SRC ||=
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { parseDocument, type Block } from "../lib/pdf/parse.ts";

/**
 * Paragraphs as written: a short line that ends a sentence closes its
 * paragraph, a word broken at a line end is made whole, and a sentence that
 * runs over a page break stays one paragraph.
 */
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};
const paragraphs = (blocks: Block[]) => blocks.filter((b) => b.type === "paragraph").map((b) => b.text);
const lines = (p: PDFPage, f: PDFFont, top: number, texts: string[]) =>
  texts.forEach((t, i) => p.drawText(t, { x: 72, y: top - i * 14, size: 11, font: f }));

// 1. Block paragraphs with no indent and no space between them.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.TimesRoman);
  const p = d.addPage([595, 842]);
  lines(p, f, 760, [
    "The first paragraph starts here and runs on across the whole width of the",
    "column for a good while before it comes to a close.",
    "The second paragraph begins on the very next line, with no indent at all.",
    "It goes on for one more short line.",
    "A third one follows straight away and is a single line.",
  ]);
  const got = paragraphs((await parseDocument(await d.save())).blocks);
  check("a short line ending a sentence closes its paragraph", got.length === 3 && got[1].startsWith("The second") && got[2].startsWith("A third"),
    JSON.stringify(got));
  check("a full-width line ending a sentence does not", !!got[1]?.endsWith("indent at all. It goes on for one more short line."));
}

// 2. Words broken at a line end.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.TimesRoman);
  const p = d.addPage([595, 842]);
  lines(p, f, 760, [
    "The committee agreed that the inter-",
    "national programme would continue, with the Anglo-",
    "Saxon archive and the COVID-",
    "19 fund kept apart from the rest.",
  ]);
  const [text] = paragraphs((await parseDocument(await d.save())).blocks);
  check("a broken word is made whole", text?.includes("the international programme"), text);
  check("a hyphen before a capital or a digit stays", text?.includes("Anglo- Saxon") && text.includes("COVID- 19"), text);
}

// 3. A sentence that runs over a page break, with page numbers between.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.TimesRoman);
  const p1 = d.addPage([595, 842]);
  lines(p1, f, 100, ["The committee agreed that the international programme would continue for", "three more years, and that the"]);
  p1.drawText("1", { x: 295, y: 30, size: 10, font: f });
  const p2 = d.addPage([595, 842]);
  p2.drawText("2", { x: 295, y: 800, size: 10, font: f });
  lines(p2, f, 770, ["budget would be reviewed every six months.", "", "", "Then a new paragraph starts here on its own."]);
  const doc = await parseDocument(await d.save());
  const got = doc.blocks.filter((b) => b.type === "paragraph");
  const joined = got.find((b) => b.text.startsWith("The committee"));
  check("the sentence stays one paragraph", !!joined?.text.endsWith("and that the budget would be reviewed every six months."), JSON.stringify(got));
  check("on the page it starts on", joined?.page === 1);
  check("page numbers stay", got.some((b) => b.text === "1") && got.some((b) => b.text === "2"));
  check("the next paragraph is its own", got.some((b) => b.text === "Then a new paragraph starts here on its own." && b.page === 2));
}

// 4. A page that ends a sentence, or a next page that starts a new one, is not joined.
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.TimesRoman);
  lines(d.addPage([595, 842]), f, 100, ["The first page ends without a full stop, as a heading might"]);
  lines(d.addPage([595, 842]), f, 770, ["Before the second page starts with a capital letter."]);
  const got = paragraphs((await parseDocument(await d.save())).blocks);
  check("a capital on the next page starts a new paragraph", got.length === 2, JSON.stringify(got));
}

process.exit(failed ? 1 : 0);
