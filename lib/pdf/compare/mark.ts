/**
 * A copy of one of the compared PDFs with its changes marked as comments
 * any PDF viewer shows: words put in are highlighted, words taken out are
 * struck through, moved words underlined, pictures that look different
 * boxed, and a note sits where the other file has words this one hasn't.
 * Each says what changed. The pages themselves are left as they were.
 */
import { PDFHexString, PDFName, type PDFDocument, type PDFRef } from "pdf-lib";
import { openPdf } from "../open";
import type { Change } from "./diff";
import { marksFor, type Mark, type MarkKind, type Side } from "./marks";
import type { Box, ReadDocument } from "./words";

/** The annotation each mark becomes, and its colour; the type differs as well as the colour. */
const LOOK: Record<MarkKind, { subtype: string; color: [number, number, number] }> = {
  added: { subtype: "Highlight", color: [0.45, 0.9, 0.5] },
  removed: { subtype: "StrikeOut", color: [0.86, 0.15, 0.15] },
  moved: { subtype: "Underline", color: [0.15, 0.4, 0.9] },
  picture: { subtype: "Square", color: [0.95, 0.55, 0.05] },
  gap: { subtype: "Text", color: [0.86, 0.15, 0.15] },
};

/** Who wrote the comments, as viewers show it. */
const AUTHOR = "PDF Wizard (Compare PDFs)";

const quote = (text: string) => {
  const t = [...text];
  return `“${t.length > 300 ? `${t.slice(0, 300).join("")}…` : text}”`;
};

/** What a change's comment says on this side. */
export function commentText(c: Change, side: Side): string {
  const page = (n: number | null) => (n === null ? "" : ` (page ${n + 1})`);
  switch (c.kind) {
    case "changed":
      return side === "a" ? `Changed to ${quote(c.newText)}${page(c.newPage)}` : `Changed from ${quote(c.oldText)}${page(c.oldPage)}`;
    case "added":
      return side === "a" ? `Added in the changed version${page(c.newPage)}: ${quote(c.newText)}` : `Added: ${quote(c.newText)}`;
    case "removed":
      return side === "a" ? `Removed: ${quote(c.oldText)}` : `Removed from here${page(c.oldPage)}: ${quote(c.oldText)}`;
    case "moved":
      return side === "a" ? `Moved to page ${(c.newPage ?? 0) + 1}: ${quote(c.oldText)}` : `Moved here from page ${(c.oldPage ?? 0) + 1}: ${quote(c.newText)}`;
    case "picture":
      return side === "a" ? `Looks different on page ${(c.newPage ?? 0) + 1} of the changed version` : `Looks different from page ${(c.oldPage ?? 0) + 1} of the original`;
  }
}

/** Displayed points (from the top left) back to the page's own space: the viewport transform undone. */
function toUser(t: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = t;
  const det = a * d - b * c || 1;
  return [(d * (x - e) - c * (y - f)) / det, (-b * (x - e) + a * (y - f)) / det];
}

/** The box's corners in the page's own space: upper left, upper right, lower left, lower right as displayed. */
function corners(t: number[], box: Box): number[] {
  return [
    ...toUser(t, box.x, box.y),
    ...toUser(t, box.x + box.width, box.y),
    ...toUser(t, box.x, box.y + box.height),
    ...toUser(t, box.x + box.width, box.y + box.height),
  ];
}

function rectOf(points: number[]): number[] {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The date as a PDF writes it, D:YYYYMMDDHHmmSSZ. (Not a regex of "-", ":" and "T": Tailwind would read it as a class.) */
const pdfDate = (d: Date) => `D:${d.toISOString().slice(0, 19).split(/\D/).join("")}Z`;

function annotation(pdf: PDFDocument, kind: MarkKind, marks: Mark[], t: number[], contents: string, date: Date): PDFRef {
  const { subtype, color } = LOOK[kind];
  const quads = marks.flatMap((m) => corners(t, m.box)).map(round);
  let rect = rectOf(quads).map(round);
  const dict: Record<string, unknown> = {
    Type: "Annot",
    Subtype: subtype,
    C: color,
    Contents: PDFHexString.fromText(contents),
    T: PDFHexString.fromText(AUTHOR),
    M: PDFHexString.fromText(pdfDate(date)),
    // Printed, as a reviewer's comments are.
    F: 4,
  };
  if (kind === "gap") {
    // A note's icon, its corner at the spot.
    const [x, , , y] = rect;
    rect = [x, y - 18, x + 18, y].map(round);
    dict.Name = PDFName.of("Comment");
  } else if (kind === "picture") {
    dict.BS = pdf.context.obj({ W: 1.5 });
  } else {
    dict.QuadPoints = quads;
  }
  dict.Rect = rect;
  return pdf.context.register(pdf.context.obj(dict as Parameters<typeof pdf.context.obj>[0]));
}

/** `bytes` (the original for side "a", the changed version for "b") with its changes marked. */
export async function markPdf(bytes: Uint8Array, side: Side, changes: Change[], doc: ReadDocument, date = new Date()): Promise<Uint8Array> {
  const pdf = await openPdf(bytes);
  const pages = pdf.getPages();
  // One comment per change and page: a change over two pages has one on each.
  const groups = new Map<string, Mark[]>();
  for (const [n, m] of marksFor(side, changes, doc.words).entries()) {
    // Each changed area of a picture gets its own box.
    const key = m.kind === "picture" ? `area ${n}` : `${m.change}:${m.page}:${m.kind}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  let marked = 0;
  for (const list of groups.values()) {
    const { page, kind, change } = list[0];
    const info = doc.pages[page];
    const target = pages[page];
    if (!info || !target) continue;
    target.node.addAnnot(annotation(pdf, kind, list, info.transform, commentText(changes[change], side), date));
    marked++;
  }
  if (marked) pdf.setModificationDate(date);
  return pdf.save();
}
