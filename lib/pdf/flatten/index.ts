/**
 * Flattening: form fields and annotations become part of the page itself, so
 * nothing on it can be filled in or edited again, and every reader shows the
 * same thing. Each widget or annotation's own appearance (the picture readers
 * draw for it) is painted into the page's content where readers paint it,
 * then the widget or annotation is removed. Text, links and the rest of the
 * page stay as they are, so text can still be selected and searched.
 *
 * Pure TypeScript on pdf-lib, so it runs in a worker and in Node tests.
 * Pages as images (the third choice) is in raster.ts: it needs a canvas.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFRef,
  PDFStream,
  StandardFonts,
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
  type PDFFont,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { openPdf } from "../open";
import { dropUnreachable } from "../operations";
import { stopIfAborted } from "../../abort";

/** What to flatten: fields only, or fields and annotations (comments, highlights, stamps…). */
export type FlattenScope = "forms" | "annotations";

export interface FlattenReport {
  /** Form fields made part of the page. */
  fields: number;
  /** Annotations made part of the page (their pop-ups go with them). */
  annotations: number;
  /** Fields left fillable: their value has letters the standard font can't draw. */
  keptFields: number;
  /** Annotations that had no picture of their own, so nothing of them shows any more. */
  blank: number;
}

/** The file has nothing that flattening would change. */
export class NothingToFlattenError extends Error {}

const N = PDFName.of;
const Annots = N("Annots");
const AcroForm = N("AcroForm");
const Subtype = N("Subtype");
const Widget = N("Widget");

// Annotation flags (PDF 32000-1, 12.5.3): hidden ones are never shown.
const HIDDEN = 1 << 1;
const NO_VIEW = 1 << 5;

/** Annotations that aren't page content: links keep working, pop-ups go with their note. */
const KEPT = new Set(["Link"]);
const DROPPED = new Set(["Popup"]);

type Matrix = [number, number, number, number, number, number];

function numbers(obj: PDFObject | undefined, count: number): number[] | null {
  if (!(obj instanceof PDFArray) || obj.size() < count) return null;
  const out: number[] = [];
  for (let i = 0; i < obj.size(); i++) {
    const v = obj.get(i);
    out.push(v instanceof PDFNumber ? v.asNumber() : NaN);
  }
  return out.every(Number.isFinite) ? out : null;
}

function lookupNumbers(dict: PDFDict, key: string, count: number): number[] | null {
  return numbers(dict.lookup(N(key)), count);
}

function flagsOf(dict: PDFDict): number {
  const f = dict.lookup(N("F"));
  return f instanceof PDFNumber ? f.asNumber() : 0;
}

/** The Rect, normalised so x0 < x1 and y0 < y1. */
function rectOf(dict: PDFDict): [number, number, number, number] | null {
  const r = lookupNumbers(dict, "Rect", 4);
  if (!r) return null;
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** A field's value, from the widget up through its parents (/V is inheritable). */
function inheritedValue(dict: PDFDict): PDFObject | undefined {
  let node: PDFDict | undefined = dict;
  for (let depth = 0; node && depth < 32; depth++) {
    const v = node.lookup(N("V"));
    if (v) return v;
    const parent: PDFObject | undefined = node.lookup(N("Parent"));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/**
 * The normal appearance stream readers draw for this annotation: /AP /N, or
 * for a checkbox, radio button or anything with states, the state /AS names.
 */
function normalAppearance(doc: PDFDocument, dict: PDFDict): { ref: PDFRef; stream: PDFStream } | null {
  const ap = dict.lookup(N("AP"));
  if (!(ap instanceof PDFDict)) return null;
  let raw = ap.get(N("N"));
  let value = doc.context.lookup(raw);
  if (value instanceof PDFDict) {
    // States: on/off for checkboxes and radio buttons.
    const as = dict.lookup(N("AS"));
    const v = inheritedValue(dict);
    const state = as instanceof PDFName ? as : v instanceof PDFName ? v : N("Off");
    raw = value.get(state);
    value = doc.context.lookup(raw);
  }
  if (!(value instanceof PDFStream)) return null;
  const ref = raw instanceof PDFRef ? raw : doc.context.register(value);
  return { ref, stream: value };
}

function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A resource on the page under a fresh name, e.g. the appearance as an XObject. */
function addResource(page: PDFPage, category: string, prefix: string, value: PDFObject): PDFName {
  const { Resources } = page.node.normalizedEntries();
  let dict = Resources.lookup(N(category));
  if (!(dict instanceof PDFDict)) {
    dict = page.doc.context.obj({});
    Resources.set(N(category), dict);
  }
  const d = dict as PDFDict;
  let i = 1;
  while (d.has(N(`${prefix}${i}`))) i++;
  const key = N(`${prefix}${i}`);
  d.set(key, value);
  return key;
}

const op = (name: Ops, ...args: (number | PDFName)[]) =>
  PDFOperator.of(name, args.map((a) => (typeof a === "number" ? PDFNumber.of(a) : a)));

/** Wraps drawing in the annotation's layer, if it has one, so it shows and hides with that layer. */
function inLayer(page: PDFPage, dict: PDFDict, ops: PDFOperator[]): PDFOperator[] {
  const oc = dict.get(N("OC"));
  if (!oc) return ops;
  const key = addResource(page, "Properties", "FlatOC", oc);
  return [op(Ops.BeginMarkedContentSequence, N("OC"), key), ...ops, op(Ops.EndMarkedContent)];
}

/**
 * Paints the annotation's appearance where readers draw it: the appearance's
 * box (BBox through its Matrix) is fitted onto the annotation's Rect
 * (PDF 32000-1, 12.5.5). False when it has no appearance to paint.
 */
function paintAppearance(doc: PDFDocument, page: PDFPage, dict: PDFDict): boolean {
  const appearance = normalAppearance(doc, dict);
  const rect = rectOf(dict);
  if (!appearance || !rect) return false;
  const { stream, ref } = appearance;
  const bbox = numbers(stream.dict.lookup(N("BBox")), 4);
  if (!bbox) return false;
  const matrix = (numbers(stream.dict.lookup(N("Matrix")), 6) ?? [1, 0, 0, 1, 0, 0]) as Matrix;
  const corners = [
    transformPoint(matrix, bbox[0], bbox[1]),
    transformPoint(matrix, bbox[2], bbox[1]),
    transformPoint(matrix, bbox[0], bbox[3]),
    transformPoint(matrix, bbox[2], bbox[3]),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const bw = Math.max(...xs) - Math.min(...xs);
  const bh = Math.max(...ys) - Math.min(...ys);
  const rw = rect[2] - rect[0];
  const rh = rect[3] - rect[1];
  if (!(bw > 0 && bh > 0 && rw > 0 && rh > 0)) return false;
  // Appearances are meant to be form XObjects; some writers leave the type out.
  stream.dict.set(N("Type"), N("XObject"));
  stream.dict.set(Subtype, N("Form"));
  const sx = rw / bw;
  const sy = rh / bh;
  const name = addResource(page, "XObject", "FlatAP", ref);
  page.pushOperators(
    ...inLayer(page, dict, [
      op(Ops.PushGraphicsState),
      op(Ops.ConcatTransformationMatrix, sx, 0, 0, sy, rect[0] - Math.min(...xs) * sx, rect[1] - Math.min(...ys) * sy),
      op(Ops.DrawObject, name),
      op(Ops.PopGraphicsState),
    ])
  );
  return true;
}

/** Colour operators for an annotation colour array (gray, RGB or CMYK), or null for none. */
function colour(values: number[] | null, stroke: boolean): PDFOperator | null {
  if (!values) return null;
  if (values.length === 1) return op(stroke ? Ops.StrokingColorGray : Ops.NonStrokingColorGray, values[0]);
  if (values.length === 3) return op(stroke ? Ops.StrokingColorRgb : Ops.NonStrokingColorRgb, ...values);
  if (values.length === 4) return op(stroke ? Ops.StrokingColorCmyk : Ops.NonStrokingColorCmyk, ...values);
  return null;
}

function colourOf(dict: PDFDict, key: string): number[] | null {
  const v = dict.lookup(N(key));
  if (!(v instanceof PDFArray) || v.size() === 0) return null;
  return numbers(v, 1);
}

function borderWidth(dict: PDFDict): number {
  const bs = dict.lookup(N("BS"));
  const w = bs instanceof PDFDict ? bs.lookup(N("W")) : undefined;
  if (w instanceof PDFNumber) return w.asNumber();
  const border = lookupNumbers(dict, "Border", 3);
  return border ? border[2] : 1;
}

/** Opacity (/CA) and, for highlights, the multiply blend readers use. */
function graphicsState(page: PDFPage, dict: PDFDict, multiply: boolean): PDFOperator[] {
  const ca = dict.lookup(N("CA"));
  const alpha = ca instanceof PDFNumber ? Math.max(0, Math.min(1, ca.asNumber())) : 1;
  if (alpha >= 1 && !multiply) return [];
  const gs = page.doc.context.obj({ Type: "ExtGState", CA: alpha, ca: alpha, ...(multiply ? { BM: "Multiply" } : {}) });
  return [op(Ops.SetGraphicsStateParams, addResource(page, "ExtGState", "FlatGS", gs))];
}

/** Bézier ellipse inside a box. */
function ellipse(x0: number, y0: number, x1: number, y1: number): PDFOperator[] {
  const k = 0.5523;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  return [
    op(Ops.MoveTo, cx + rx, cy),
    op(Ops.AppendBezierCurve, cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
    op(Ops.AppendBezierCurve, cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
    op(Ops.AppendBezierCurve, cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
    op(Ops.AppendBezierCurve, cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
    op(Ops.ClosePath),
  ];
}

function polyline(points: number[], close: boolean): PDFOperator[] {
  const ops: PDFOperator[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) ops.push(op(i ? Ops.LineTo : Ops.MoveTo, points[i], points[i + 1]));
  if (close && ops.length) ops.push(op(Ops.ClosePath));
  return ops;
}

/**
 * Markup with no appearance of its own (some writers leave it to the reader):
 * drawn here as readers draw it, from its colour, border and points. False
 * for kinds readers draw from fonts or icons, such as free text and notes.
 */
function paintPlain(page: PDFPage, dict: PDFDict, kind: string): boolean {
  const drawing = plainDrawing(dict, kind);
  return !!drawing && draw(page, dict, drawing.multiply, drawing.ops);
}

/**
 * What paintPlain draws, in page space: the operators, and whether readers
 * multiply it onto the page (highlights). Null for kinds it can't draw.
 * PDF/A uses it to give such markup an appearance of its own.
 */
export function plainDrawing(dict: PDFDict, kind: string): { ops: PDFOperator[]; multiply: boolean } | null {
  const stroke = colour(colourOf(dict, "C"), true);
  const fillColour = colour(colourOf(dict, "C"), false);
  const interior = colour(colourOf(dict, "IC"), false);
  const width = borderWidth(dict);
  const rect = rectOf(dict);
  const body: PDFOperator[] = [];
  const quads = lookupNumbers(dict, "QuadPoints", 8);

  switch (kind) {
    case "Highlight":
    case "Underline":
    case "StrikeOut":
    case "Squiggly": {
      if (!quads || !fillColour || !stroke) return null;
      for (let i = 0; i + 7 < quads.length; i += 8) {
        const q = quads.slice(i, i + 8);
        const ys = [q[1], q[3], q[5], q[7]];
        const top = Math.max(...ys);
        const bottom = Math.min(...ys);
        const left = Math.min(q[0], q[2], q[4], q[6]);
        const right = Math.max(q[0], q[2], q[4], q[6]);
        const h = top - bottom;
        if (kind === "Highlight") {
          // Corners as written: top-left, top-right, bottom-left, bottom-right.
          body.push(...polyline([q[0], q[1], q[2], q[3], q[6], q[7], q[4], q[5]], true), op(Ops.FillNonZero));
        } else {
          const y = kind === "StrikeOut" ? bottom + h / 2 : bottom + h / 14;
          body.push(op(Ops.SetLineWidth, Math.max(1, h / 14)), op(Ops.MoveTo, left, y), op(Ops.LineTo, right, y), op(Ops.StrokePath));
        }
      }
      return { multiply: kind === "Highlight", ops: [kind === "Highlight" ? fillColour : stroke, ...body] };
    }
    case "Square":
    case "Circle": {
      if (!rect || (!stroke && !interior)) return null;
      const inset = stroke ? width / 2 : 0;
      const [x0, y0, x1, y1] = [rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset];
      if (x1 <= x0 || y1 <= y0) return null;
      const path = kind === "Square" ? [op(Ops.AppendRectangle, x0, y0, x1 - x0, y1 - y0)] : ellipse(x0, y0, x1, y1);
      const paint = stroke && interior && width > 0 ? Ops.FillNonZeroAndStroke : interior ? Ops.FillNonZero : Ops.StrokePath;
      const set = [stroke, interior].filter((o): o is PDFOperator => !!o);
      return { multiply: false, ops: [...set, op(Ops.SetLineWidth, width), ...path, op(paint)] };
    }
    case "Ink": {
      const list = dict.lookup(N("InkList"));
      if (!(list instanceof PDFArray) || !stroke) return null;
      for (let i = 0; i < list.size(); i++) {
        const pts = numbers(dict.context.lookup(list.get(i)), 2);
        if (pts) body.push(...polyline(pts, false), op(Ops.StrokePath));
      }
      if (!body.length) return null;
      return { multiply: false, ops: [stroke, op(Ops.SetLineWidth, width), op(Ops.SetLineCapStyle, 1), op(Ops.SetLineJoinStyle, 1), ...body] };
    }
    case "Line": {
      const l = lookupNumbers(dict, "L", 4);
      if (!l || !stroke) return null;
      return { multiply: false, ops: [stroke, op(Ops.SetLineWidth, width), ...polyline(l, false), op(Ops.StrokePath)] };
    }
    case "Polygon":
    case "PolyLine": {
      const v = lookupNumbers(dict, "Vertices", 4);
      if (!v || (!stroke && !interior)) return null;
      const closed = kind === "Polygon";
      const paint = closed && interior ? (stroke ? Ops.FillNonZeroAndStroke : Ops.FillNonZero) : Ops.StrokePath;
      const set = [stroke, closed ? interior : null].filter((o): o is PDFOperator => !!o);
      return { multiply: false, ops: [...set, op(Ops.SetLineWidth, width), ...polyline(v, closed), op(paint)] };
    }
  }
  return null;
}

function draw(page: PDFPage, dict: PDFDict, multiply: boolean, body: PDFOperator[]): boolean {
  page.pushOperators(
    ...inLayer(page, dict, [op(Ops.PushGraphicsState), ...graphicsState(page, dict, multiply), ...body, op(Ops.PopGraphicsState)])
  );
  return true;
}

const isTextLike = (field: PDFField) =>
  field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList;

/**
 * Brings each field's picture up to date with its value, so what gets
 * painted is what the field holds. Returns the widgets of fields whose value
 * the standard font can't draw (Arabic, Greek, Cyrillic…): those stay
 * fillable, since flattening would show nothing or an old value.
 */
async function refreshFields(doc: PDFDocument): Promise<{ keep: Set<PDFDict>; fields: PDFField[] }> {
  const keep = new Set<PDFDict>();
  let fields: PDFField[];
  try {
    fields = doc.getForm().getFields();
  } catch {
    // A form pdf-lib can't read: its widgets are painted as they are.
    return { keep, fields: [] };
  }
  if (!fields.length) return { keep, fields };
  const form = doc.getForm();
  let font: PDFFont | undefined;
  // Readers redraw every field when asked to: the stored pictures may be stale.
  const redrawAll = form.acroForm.dict.lookup(N("NeedAppearances")) === PDFBool.True;
  for (const field of fields) {
    try {
      if (field.needsAppearancesUpdate() || (redrawAll && isTextLike(field))) {
        font ??= await doc.embedFont(StandardFonts.Helvetica);
        field.defaultUpdateAppearances(font);
      }
    } catch {
      for (const widget of field.acroField.getWidgets()) keep.add(widget.dict);
    }
  }
  return { keep, fields };
}

/** Every object of the field tree, for deleting it with the form. */
function fieldTreeRefs(doc: PDFDocument, form: PDFDict): PDFRef[] {
  const out: PDFRef[] = [];
  const seen = new Set<PDFRef>();
  const walk = (list: PDFObject | undefined, depth: number) => {
    const arr = doc.context.lookup(list);
    if (!(arr instanceof PDFArray) || depth > 32) return;
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i);
      if (!(ref instanceof PDFRef) || seen.has(ref)) continue;
      seen.add(ref);
      out.push(ref);
      const node = doc.context.lookup(ref);
      if (node instanceof PDFDict) walk(node.get(N("Kids")), depth + 1);
    }
  };
  walk(form.get(N("Fields")), 0);
  return out;
}

/**
 * Flattens `doc` in place. Forms only, or forms and annotations; links stay.
 */
export async function flattenDocument(
  doc: PDFDocument,
  scope: FlattenScope,
  opts: { onProgress?: (fraction: number, label: string) => void; signal?: AbortSignal } = {}
): Promise<FlattenReport> {
  const report: FlattenReport = { fields: 0, annotations: 0, keptFields: 0, blank: 0 };
  const catalogForm = doc.catalog.lookup(AcroForm);
  const hasForm = catalogForm instanceof PDFDict;
  const { keep, fields } = hasForm ? await refreshFields(doc) : { keep: new Set<PDFDict>(), fields: [] };
  const removed: PDFRef[] = [];
  let widgets = 0;

  const pages = doc.getPages();
  pages.forEach((page, p) => {
    stopIfAborted(opts.signal);
    if (pages.length >= 20 && p % 10 === 0) opts.onProgress?.(p / pages.length, `Page ${p + 1} of ${pages.length}`);
    const annots = page.node.Annots();
    if (!annots) return;
    const left: PDFObject[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = doc.context.lookup(raw);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = dict.lookup(Subtype);
      const kind = subtype instanceof PDFName ? subtype.decodeText() : "";
      const isWidget = subtype === Widget;
      if (isWidget ? keep.has(dict) : scope === "forms" || KEPT.has(kind)) {
        left.push(raw);
        continue;
      }
      if (DROPPED.has(kind)) {
        if (raw instanceof PDFRef) removed.push(raw);
        continue;
      }
      const shown = !(flagsOf(dict) & (HIDDEN | NO_VIEW));
      const painted = shown && (paintAppearance(doc, page, dict) || (!isWidget && paintPlain(page, dict, kind)));
      if (isWidget) widgets++;
      else {
        report.annotations++;
        if (shown && !painted) report.blank++;
      }
      if (raw instanceof PDFRef) removed.push(raw);
    }
    if (left.length === annots.size()) return;
    if (left.length) page.node.set(Annots, doc.context.obj(left));
    else page.node.delete(Annots);
  });

  // Count fields, not widgets: a radio group is one field however many buttons it has.
  for (const field of fields) {
    if (field.acroField.getWidgets().some((w) => keep.has(w.dict))) report.keptFields++;
    else report.fields++;
  }
  // A form pdf-lib couldn't read, or widgets outside the form: count what was painted.
  if (!fields.length) report.fields = widgets;

  if (hasForm) {
    if (!keep.size) {
      // Nothing fillable is left: the form goes, with its XFA twin, which
      // readers that know XFA would otherwise show in its place.
      const formRef = doc.catalog.get(AcroForm);
      removed.push(...fieldTreeRefs(doc, catalogForm as PDFDict));
      if (formRef instanceof PDFRef) removed.push(formRef);
      doc.catalog.delete(AcroForm);
    } else {
      const form = doc.getForm();
      for (const field of fields) {
        if (field.acroField.getWidgets().some((w) => keep.has(w.dict))) continue;
        try {
          form.acroForm.removeField(field.acroField);
        } catch {
          // Already gone with its parent.
        }
      }
      form.acroForm.dict.delete(N("XFA"));
      // The fields that stay are drawn by the reader (see lib/pdf/forms.ts drawFields).
      form.acroForm.dict.set(N("NeedAppearances"), PDFBool.True);
    }
  }

  // Leave no copy of the old fields and comments in the file: nor what only
  // they pointed at, such as an attached file, the XFA data or an old picture.
  for (const ref of new Set(removed)) doc.context.delete(ref);
  dropUnreachable(doc);
  return report;
}

/** Where to go when there is nothing to flatten: pictures of the pages work on any file. */
const WHOLE_PAGE = "To lock the whole page, choose Pages as images.";

/** True when flattening would change nothing: no fields, and (for annotations) nothing but links. */
function nothingTo(report: FlattenReport, scope: FlattenScope): boolean {
  return report.fields + report.keptFields === 0 && (scope === "forms" || report.annotations === 0);
}

export async function flattenPdf(
  bytes: Uint8Array,
  scope: FlattenScope,
  opts: { onProgress?: (fraction: number, label: string) => void; signal?: AbortSignal } = {}
): Promise<{ bytes: Uint8Array; report: FlattenReport }> {
  const doc = await openPdf(bytes);
  stopIfAborted(opts.signal);
  const report = await flattenDocument(doc, scope, opts);
  if (nothingTo(report, scope)) {
    throw new NothingToFlattenError(
      scope === "forms"
        ? hasAnnotations(doc)
          ? "This PDF has no form fields. To flatten its comments, choose Fields and comments."
          : `This PDF has no form fields to flatten. ${WHOLE_PAGE}`
        : `This PDF has no form fields or comments to flatten. ${WHOLE_PAGE}`
    );
  }
  opts.onProgress?.(1, "Saving…");
  stopIfAborted(opts.signal);
  return { bytes: await doc.save({ updateFieldAppearances: false }), report };
}

function hasAnnotations(doc: PDFDocument): boolean {
  return doc.getPages().some((page) => {
    const annots = page.node.Annots();
    if (!annots) return false;
    for (let i = 0; i < annots.size(); i++) {
      const dict = doc.context.lookup(annots.get(i));
      const kind = dict instanceof PDFDict ? dict.lookup(Subtype) : undefined;
      if (kind instanceof PDFName && !KEPT.has(kind.decodeText()) && !DROPPED.has(kind.decodeText()) && kind !== Widget) return true;
    }
    return false;
  });
}

/** A short line for the result: what stayed as it was, if anything. */
export function flattenNote(report: FlattenReport): string | undefined {
  const parts: string[] = [];
  const n = report.keptFields;
  if (n) parts.push(`${n} field${n === 1 ? "" : "s"} left fillable: ${n === 1 ? "its" : "their"} letters can't be drawn in this PDF`);
  const b = report.blank;
  if (b) parts.push(`${b} comment${b === 1 ? "" : "s"} with nothing to show ${b === 1 ? "was" : "were"} removed`);
  return parts.length ? parts.join(". ") + "." : undefined;
}

/**
 * The editor's "Flatten form fields when saving or downloading": the same
 * bytes back when there is no form, and a note when some fields stayed.
 */
export async function flattenFormsIfAny(bytes: Uint8Array): Promise<{ bytes: Uint8Array; note?: string }> {
  try {
    const { bytes: out, report } = await flattenPdf(bytes, "forms");
    return { bytes: out, note: flattenNote(report) };
  } catch (err) {
    if (err instanceof NothingToFlattenError) return { bytes };
    throw err;
  }
}
