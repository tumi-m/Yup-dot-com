/**
 * Comments and links as PDF/A asks for them (6.3): only kinds ISO 32000-1
 * defines (no sound, film, screen or 3D), each printed (Print flag on, none
 * of the hiding flags), and each with a normal appearance of its own and no
 * other. Markup that relies on the reader to draw it is given its picture
 * here; a note gets a note icon. One that can't be drawn is removed, and
 * counted.
 *
 * Form fields are flattened before this (index.ts), so the widgets left are
 * those whose pages become pictures.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFRef,
  PDFStream,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFObject,
} from "pdf-lib";
import { plainDrawing } from "../flatten";
import type { Part } from "./metadata";

const N = PDFName.of;

// Annotation flags (PDF 32000-1, 12.5.3).
const INVISIBLE = 1;
const HIDDEN = 2;
const PRINT = 4;
const NO_VIEW = 32;
const TOGGLE_NO_VIEW = 256;

/** The kinds PDF/A-2 and 3 allow (6.3.1). FileAttachment only in PDF/A-3, where attachments are allowed. */
const ALLOWED = new Set([
  "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly",
  "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "FileAttachment", "Widget", "PrinterMark", "TrapNet", "Watermark", "Redact",
]);
const MEDIA = new Set(["Sound", "Movie", "Screen", "3D", "RichMedia"]);

export interface AnnotationReport {
  /** Sound, film, screen and 3D. */
  media: number;
  /** File attachments (PDF/A-2b). */
  attachments: number;
  /** Hidden ones, which never showed. */
  hidden: number;
  /** Ones with nothing to show and no way to draw them. */
  blank: number;
  /** Ones given an appearance here. */
  drawn: number;
}

const op = (name: Ops, ...args: (number | PDFName)[]) => PDFOperator.of(name, args.map((a) => (typeof a === "number" ? PDFNumber.of(a) : a)));

function rectOf(dict: PDFDict): [number, number, number, number] | null {
  const r = dict.lookup(N("Rect"));
  if (!(r instanceof PDFArray) || r.size() < 4) return null;
  const v = [0, 1, 2, 3].map((i) => r.lookup(i)).map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN));
  if (!v.every(Number.isFinite)) return null;
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

function colourOf(dict: PDFDict, key: string): number[] | null {
  const v = dict.lookup(N(key));
  if (!(v instanceof PDFArray) || !v.size()) return null;
  const out: number[] = [];
  for (let i = 0; i < v.size(); i++) {
    const n = v.lookup(i);
    out.push(n instanceof PDFNumber ? n.asNumber() : 0);
  }
  return out;
}

function fill(c: number[] | null): PDFOperator | null {
  if (!c) return null;
  if (c.length === 1) return op(Ops.NonStrokingColorGray, c[0]);
  if (c.length === 3) return op(Ops.NonStrokingColorRgb, c[0], c[1], c[2]);
  if (c.length === 4) return op(Ops.NonStrokingColorCmyk, c[0], c[1], c[2], c[3]);
  return null;
}

/** A form XObject on the annotation's Rect (its BBox), drawn in page space. */
function appearance(doc: PDFDocument, rect: number[], ops: PDFOperator[], resources: Record<string, unknown> = {}): PDFRef {
  const ctx = doc.context;
  const stream = ctx.formXObject(ops, { BBox: rect, Resources: ctx.obj(resources as never) });
  return ctx.register(stream);
}

/** A note's icon: a sheet in its colour with three lines, in the top left of its box. */
function noteIcon(doc: PDFDocument, dict: PDFDict, rect: [number, number, number, number]): PDFRef {
  const size = Math.min(20, rect[2] - rect[0], rect[3] - rect[1]);
  const x = rect[0];
  const y = rect[3] - size;
  const ops = [
    op(Ops.PushGraphicsState),
    fill(colourOf(dict, "C")) ?? op(Ops.NonStrokingColorRgb, 1, 0.9, 0.3),
    op(Ops.StrokingColorGray, 0.25),
    op(Ops.SetLineWidth, Math.max(0.5, size / 30)),
    op(Ops.AppendRectangle, x + size * 0.1, y + size * 0.1, size * 0.8, size * 0.8),
    op(Ops.FillNonZeroAndStroke),
    ...[0.65, 0.48, 0.31].flatMap((f) => [op(Ops.MoveTo, x + size * 0.25, y + size * f), op(Ops.LineTo, x + size * 0.75, y + size * f)]),
    op(Ops.StrokePath),
    op(Ops.PopGraphicsState),
  ];
  return appearance(doc, rect, ops);
}

/** Free text with no picture: its words in the box, in Helvetica (the font substitution embeds it). Null when they can't be written so. */
async function freeTextAppearance(doc: PDFDocument, dict: PDFDict, rect: [number, number, number, number], fonts: { font?: PDFFont }): Promise<PDFRef | null> {
  const contents = dict.lookup(N("Contents"));
  const text = contents && "decodeText" in contents ? (contents as unknown as { decodeText(): string }).decodeText() : "";
  if (!text.trim()) return null;
  const font = (fonts.font ??= await doc.embedFont(StandardFonts.Helvetica));
  const da = dict.lookup(N("DA"));
  const size = Number(/([\d.]+)\s+Tf/.exec(da && "decodeText" in da ? (da as unknown as { decodeText(): string }).decodeText() : "")?.[1]) || 10;
  const width = rect[2] - rect[0] - 4;
  const lines: string[] = [];
  try {
    for (const para of text.split(/\r\n|\r|\n/)) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && font.widthOfTextAtSize(next, size) > width) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    font.encodeText(text.replace(/\s+/g, " "));
  } catch {
    return null;
  }
  const ops: PDFOperator[] = [op(Ops.PushGraphicsState), op(Ops.BeginText), op(Ops.SetFontAndSize, N("F1"), size), op(Ops.NonStrokingColorGray, 0)];
  let y = rect[3] - 2 - size;
  for (const line of lines) {
    if (y < rect[1]) break;
    ops.push(op(Ops.SetTextMatrix, 1, 0, 0, 1, rect[0] + 2, y), PDFOperator.of(Ops.ShowText, [font.encodeText(line)]));
    y -= size * 1.2;
  }
  ops.push(op(Ops.EndText), op(Ops.PopGraphicsState));
  return appearance(doc, rect, ops, { Font: { F1: font.ref } });
}

/** An appearance for markup readers draw from its points (highlights, shapes, ink), with its opacity. */
function plainAppearance(doc: PDFDocument, dict: PDFDict, kind: string, rect: [number, number, number, number]): PDFRef | null {
  const drawing = plainDrawing(dict, kind);
  if (!drawing) return null;
  const ca = dict.lookup(N("CA"));
  const alpha = ca instanceof PDFNumber ? Math.max(0, Math.min(1, ca.asNumber())) : 1;
  const resources: Record<string, unknown> = {};
  const ops: PDFOperator[] = [op(Ops.PushGraphicsState)];
  if (alpha < 1 || drawing.multiply) {
    resources.ExtGState = { GS1: { Type: "ExtGState", CA: alpha, ca: alpha, ...(drawing.multiply ? { BM: "Multiply" } : {}) } };
    ops.push(op(Ops.SetGraphicsStateParams, N("GS1")));
  }
  ops.push(...drawing.ops, op(Ops.PopGraphicsState));
  return appearance(doc, rect, ops, resources);
}

/** The annotation's normal appearance as one stream (a state picked, the others gone); null when it has none. */
function normalStream(doc: PDFDocument, dict: PDFDict, ap: PDFDict): PDFObject | null {
  const raw = ap.get(N("N"));
  const value = doc.context.lookup(raw);
  if (value instanceof PDFStream) return raw ?? null;
  if (!(value instanceof PDFDict)) return null;
  const as = dict.lookup(N("AS"));
  const pick = as instanceof PDFName ? value.get(as) : undefined;
  const stream = doc.context.lookup(pick);
  return stream instanceof PDFStream ? pick! : null;
}

/** Fixes every annotation on every page (see the top of the file). */
export async function fixAnnotations(doc: PDFDocument, part: Part): Promise<AnnotationReport> {
  const report: AnnotationReport = { media: 0, attachments: 0, hidden: 0, blank: 0, drawn: 0 };
  const fonts: { font?: PDFFont } = {};
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    const kept: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = doc.context.lookup(raw);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(N("Subtype"));
      const kind = subtype instanceof PDFName ? subtype.decodeText() : "";
      if (MEDIA.has(kind) || !ALLOWED.has(kind)) {
        report.media++;
        continue;
      }
      if (kind === "FileAttachment" && part === 2) {
        report.attachments++;
        continue;
      }
      const f = dict.lookup(N("F"));
      const flags = f instanceof PDFNumber ? f.asNumber() : 0;
      if (kind === "Popup") {
        // A pop-up shows with its note; it may go without flags (6.3.2).
        dict.delete(N("F"));
      } else if (flags & (HIDDEN | NO_VIEW | INVISIBLE)) {
        // Never shown: made visible it would change the page.
        report.hidden++;
        continue;
      } else {
        dict.set(N("F"), PDFNumber.of((flags | PRINT) & ~(INVISIBLE | HIDDEN | NO_VIEW | TOGGLE_NO_VIEW)));
      }
      const ap = dict.lookup(N("AP"));
      if (ap instanceof PDFDict) {
        // Only the normal appearance (6.3.3): no rollover or pressed one.
        ap.delete(N("D"));
        ap.delete(N("R"));
        if (kind !== "Widget") {
          const stream = normalStream(doc, dict, ap);
          if (stream) ap.set(N("N"), stream);
          else dict.delete(N("AP"));
        }
      }
      const rect = rectOf(dict);
      const exempt = kind === "Popup" || kind === "Link" || (rect && rect[0] === rect[2] && rect[1] === rect[3]);
      if (!exempt && !(dict.lookup(N("AP")) instanceof PDFDict)) {
        const made =
          rect && rect[2] > rect[0] && rect[3] > rect[1]
            ? kind === "Text"
              ? noteIcon(doc, dict, rect)
              : kind === "FreeText"
                ? await freeTextAppearance(doc, dict, rect, fonts)
                : plainAppearance(doc, dict, kind, rect)
            : null;
        if (!made) {
          report.blank++;
          continue;
        }
        dict.set(N("AP"), doc.context.obj({ N: made }));
        report.drawn++;
      }
      // Appearance streams are form XObjects; some writers leave that out.
      const n = doc.context.lookup((dict.lookup(N("AP")) as PDFDict | undefined)?.get(N("N")));
      if (n instanceof PDFStream) {
        n.dict.set(N("Type"), N("XObject"));
        n.dict.set(N("Subtype"), N("Form"));
      }
      kept.push(raw);
    }
    if (kept.length === annots.size()) continue;
    if (kept.length) page.node.set(N("Annots"), doc.context.obj(kept));
    else page.node.delete(N("Annots"));
  }
  return report;
}

/** Links whose only action was taken out (a script, say): they lead nowhere now, so they go. */
export function dropDeadLinks(doc: PDFDocument): number {
  let dropped = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    const kept: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      const dead = a instanceof PDFDict && a.lookup(N("Subtype")) === N("Link") && !a.has(N("A")) && !a.has(N("Dest"));
      if (dead) dropped++;
      else kept.push(annots.get(i));
    }
    if (kept.length === annots.size()) continue;
    if (kept.length) page.node.set(N("Annots"), doc.context.obj(kept));
    else page.node.delete(N("Annots"));
  }
  return dropped;
}
