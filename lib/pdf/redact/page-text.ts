import type { PDFPageProxy } from "pdfjs-dist";
import type { Flow, NoteText, PageText, Rect, TextRun } from "./marks";

/**
 * A page's text as Redact PDF marks and checks it: each run pdf.js reads,
 * boxed in displayed points from the top-left with the way its letters go,
 * and the text its comments, links and form fields hold. Takes any pdf.js
 * page, so Node tests can use pdf.js's legacy build.
 */
export async function pageText(page: PDFPageProxy): Promise<PageText> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs: TextRun[] = [];
  for (const item of content.items) {
    if (!("str" in item)) continue;
    if (!item.str) {
      if (item.hasEOL && runs.length) runs[runs.length - 1].eol = true;
      continue;
    }
    const [a, b, c, d, e, f] = item.transform as number[];
    const style = content.styles[item.fontName];
    const len = Math.hypot(a, b) || 1;
    // Vertical fonts advance down the page; pdf.js gives their length as the height.
    const vertical = !!style?.vertical;
    const advance = vertical ? item.height : item.width;
    const dx = vertical ? 0 : (a / len) * advance;
    const dy = vertical ? -advance : (b / len) * advance;
    // From a quarter of the font size below the baseline (descenders) to a full one above, as ownText does.
    const corners = vertical
      ? [
          [e - len / 2, f],
          [e + len / 2, f],
          [e - len / 2, f + dy],
          [e + len / 2, f + dy],
        ].map(([x, y]) => vp.convertToViewportPoint(x, y))
      : [
          [e - c / 4, f - d / 4],
          [e + c, f + d],
        ].flatMap(([x, y]) => [vp.convertToViewportPoint(x, y), vp.convertToViewportPoint(x + dx, y + dy)]);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const rect: Rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const [sx, sy] = vp.convertToViewportPoint(e, f);
    const [tx, ty] = vp.convertToViewportPoint(e + dx, f + dy);
    let flow = flowOf(tx - sx, ty - sy);
    // pdf.js gives right-to-left text in reading order: its first letter is on the right.
    if (item.dir === "rtl" && flow === "right") flow = "left";
    runs.push({ str: item.str, rect, flow, eol: !!item.hasEOL, mono: style?.fontFamily === "monospace" });
  }

  const notes: NoteText[] = [];
  for (const a of (await page.getAnnotations()) as Record<string, unknown>[]) {
    const texts = noteTexts(a);
    const r = a.rect as number[] | undefined;
    if (!texts.length || !r) continue;
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(r);
    const rect = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    for (const text of texts) notes.push({ text, rect });
  }
  return { runs, notes };
}

function flowOf(dx: number, dy: number): Flow {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return "right";
  if (Math.abs(dy) <= Math.abs(dx) * 0.05) return dx > 0 ? "right" : "left";
  if (Math.abs(dx) <= Math.abs(dy) * 0.05) return dy > 0 ? "down" : "up";
  return "angled";
}

/** What a comment, link or field says, as pdf.js reads it: its note, value, shown text, name in the list and address. */
function noteTexts(a: Record<string, unknown>): string[] {
  const out: unknown[] = [
    (a.contentsObj as { str?: string } | undefined)?.str,
    (a.richText as { str?: string } | undefined)?.str,
    (a.titleObj as { str?: string } | undefined)?.str,
    a.alternativeText,
    a.url,
    a.unsafeUrl,
  ];
  const value = a.fieldValue;
  if (Array.isArray(value)) out.push(...value);
  else out.push(value);
  if (Array.isArray(a.textContent)) out.push((a.textContent as string[]).join("\n"));
  if (Array.isArray(a.options)) for (const o of a.options as { displayValue?: string; exportValue?: string }[]) out.push(o.displayValue, o.exportValue);
  const seen = new Set<string>();
  return out.filter((t): t is string => {
    if (typeof t !== "string" || !t.trim() || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}
