/**
 * The last check before a redacted file is offered: it is opened again with
 * pdf.js, as a reader would, and every page's text, comments and fields,
 * the bookmarks, the document's details, attachments and scripts are read.
 * Redacted text must not be in any of them beyond the copies the person
 * chose to leave, no text may sit under a mark, and every mark must come
 * out black when the page is drawn.
 */
import type { LoadedPdf } from "../render";
import type { CanvasOptions } from "../crop/pictures";
import { stopIfAborted } from "../../abort";
import { allText, area, countIn, overlap, squeezedIn, wordsOf, type Needle, type Rect } from "./marks";
import type { Leak } from "./scan";

/** Details a reader always reports, which say nothing about the document's content. */
const PLAIN_INFO = new Set(["PDFFormatVersion", "Language", "EncryptFilterName", "IsLinearized", "IsAcroFormPresent", "IsXFAPresent", "IsCollectionPresent", "IsSignaturesPresent"]);

/** How dark a mark must come out: mean brightness out of 255. */
const DARK = 80;

export interface VerifyInput {
  pageCount: number;
  marked: { page: number; rects: Rect[] }[];
  needles: Needle[];
}

const inside = (x: number, y: number, r: Rect) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

export async function verifyRedaction(loaded: LoadedPdf, input: VerifyInput, opts: CanvasOptions = {}): Promise<Leak[]> {
  const leaks: Leak[] = [];
  if (loaded.numPages !== input.pageCount) return [{ text: "", where: "The redacted file lost pages" }];

  const facts = await loaded.facts();
  const said = Object.entries(facts.info).filter(([k, v]) => !PLAIN_INFO.has(k) && v !== "" && v !== null && v !== undefined && !(typeof v === "object" && !Object.keys(v as object).length));
  if (said.length || facts.xmp) leaks.push({ text: "", where: "The document's details are still in the file" });
  if (facts.attachments) leaks.push({ text: "", where: "Attached files are still in the file" });
  if (facts.scripts) leaks.push({ text: "", where: "Scripts are still in the file" });
  for (const title of facts.bookmarks) {
    for (const n of input.needles) if (countIn(title, n) > 0 || squeezedIn(title, n)) leaks.push({ text: n.text, where: "in the bookmarks" });
  }

  const marked = new Map(input.marked.map((m) => [m.page, m.rects]));
  const make = opts.canvas ?? (() => document.createElement("canvas"));
  for (let i = 0; i < loaded.numPages; i++) {
    stopIfAborted(opts.signal);
    if (i % 10 === 0) opts.progress?.(i / loaded.numPages, `Checking page ${i + 1}…`);
    const page = await loaded.pageText(i + 1);
    const text = allText(page);
    for (const n of input.needles) {
      const allowed = n.allowed[i] ?? 0;
      if (countIn(text, n) > allowed || (!allowed && squeezedIn(text, n))) leaks.push({ text: n.text, where: `on page ${i + 1}` });
    }
    const rects = marked.get(i);
    if (!rects) continue;
    // Nothing readable under a mark: no word, no comment or link.
    const under = (r: Rect) => rects.some((m) => inside((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, m) || overlap(m, r) > area(r) * 0.25);
    for (const run of page.runs) {
      for (const w of wordsOf(run)) if (under(w.rect)) leaks.push({ text: w.text, where: `under a box on page ${i + 1}` });
    }
    for (const note of page.notes) if (under(note.rect)) leaks.push({ text: note.text, where: `under a box on page ${i + 1}` });
    // Every mark comes out black.
    const vp = await loaded.getPageViewport(i + 1, 1);
    const scale = Math.min(2, 1600 / Math.max(vp.width, vp.height, 1));
    const canvas = make();
    try {
      await loaded.renderPage(i + 1, canvas, scale, { pixelRatio: 1, forms: true });
      const ctx = canvas.getContext("2d");
      const r = canvas.width / vp.width;
      for (const m of rects) {
        const x = Math.ceil(m.x0 * r + 1.5);
        const y = Math.ceil(m.y0 * r + 1.5);
        const w = Math.floor(m.x1 * r - 1.5) - x;
        const h = Math.floor(m.y1 * r - 1.5) - y;
        if (!ctx || w < 2 || h < 2) continue;
        const { data } = ctx.getImageData(x, y, w, h);
        let sum = 0;
        for (let p = 0; p < data.length; p += 4) sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
        if (sum / (data.length / 4) > DARK) {
          leaks.push({ text: "", where: `A box on page ${i + 1} didn't come out black` });
          break;
        }
      }
    } finally {
      canvas.width = canvas.height = 0;
    }
    await loaded.release(i + 1);
  }
  return leaks;
}

/** What went wrong, for people: the first few things found, and that nothing was saved. */
export function leakMessage(leaks: Leak[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of leaks) {
    const line = l.text ? `“${l.text.length > 40 ? `${l.text.slice(0, 39)}…` : l.text}” is still in the file, ${l.where}.` : `${l.where}.`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const more = lines.length > 3 ? ` And ${lines.length - 3} more.` : "";
  return `The check after redacting found text that should be gone, so nothing was saved. ${lines.slice(0, 3).join(" ")}${more}`;
}
