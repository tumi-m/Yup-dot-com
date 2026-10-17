import type { PDFPageProxy } from "pdfjs-dist";
import type { OwnText } from "./ocr-layer";

/**
 * What OCR needs to know about a page before reading it: where its own text
 * sits, and whether it shows pictures, which may hold text of their own.
 * Takes any pdf.js page, so Node tests can use pdf.js's legacy build.
 */

type Matrix = [number, number, number, number, number, number];

/** `m` then `n` applied first, as canvas transform() and PDF's cm combine them. */
function multiply(m: Matrix, n: number[]): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/**
 * The page's own text pieces, each with its box in displayed points from the
 * top-left (CropBox, /Rotate applied), as OCR measures the words it reads.
 */
export async function ownText(page: PDFPageProxy): Promise<OwnText[]> {
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const out: OwnText[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    // transform maps the font's em square to user space; width runs along the baseline.
    const [a, b, c, d, e, f] = item.transform as number[];
    const len = Math.hypot(a, b) || 1;
    const dx = (a / len) * item.width;
    const dy = (b / len) * item.width;
    // From a quarter of the font size below the baseline (descenders) to a full one above.
    const corners = [
      [e - c / 4, f - d / 4],
      [e + c, f + d],
    ].flatMap(([x, y]) => [vp.convertToViewportPoint(x, y), vp.convertToViewportPoint(x + dx, y + dy)]);
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    out.push({
      text: item.str,
      font: item.fontName,
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    });
  }
  return out;
}

/**
 * True when the page draws a picture big enough to hold words: a scan, a
 * photo, a stamp or a signature (at least 1% of the page). Bullets and small
 * icons don't count.
 */
export async function showsPictures(page: PDFPageProxy, OPS: Record<string, number>): Promise<boolean> {
  const [x0, y0, x1, y1] = page.view;
  const minArea = Math.abs((x1 - x0) * (y1 - y0)) * 0.01;
  const { fnArray, argsArray } = await page.getOperatorList();
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < fnArray.length; i++) {
    const args = argsArray[i];
    switch (fnArray[i]) {
      case OPS.save:
        stack.push(m);
        break;
      case OPS.restore:
        m = stack.pop() ?? m;
        break;
      case OPS.transform:
        m = multiply(m, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(m);
        if (args?.[0]) m = multiply(m, args[0]);
        break;
      case OPS.beginAnnotation:
        // An annotation's appearance is drawn from the page's own space.
        stack.push(m);
        m = multiply(multiply([1, 0, 0, 1, 0, 0], args[2]), args[3]);
        break;
      case OPS.paintFormXObjectEnd:
      case OPS.endAnnotation:
        m = stack.pop() ?? m;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageMaskXObject: {
        // Pictures are drawn into the unit square: their size is the matrix's.
        const w = Math.hypot(m[0], m[1]);
        const h = Math.hypot(m[2], m[3]);
        if (w * h >= minArea && Math.min(w, h) >= 6) return true;
        break;
      }
      case OPS.paintImageXObjectRepeat:
      case OPS.paintImageMaskXObjectRepeat:
      case OPS.paintInlineImageXObjectGroup:
      case OPS.paintImageMaskXObjectGroup:
        // Many pictures in a row: tiles or strips of a scan.
        return true;
    }
  }
  return false;
}
