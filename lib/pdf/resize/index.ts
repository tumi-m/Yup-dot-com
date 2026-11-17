/**
 * Resize PDF: every page onto a sheet of the chosen size, or two or four
 * pages on each sheet. Only pdf-lib, so it runs in a Web Worker
 * (off-thread.ts) as well as here.
 *
 * Pages stay vector. One page per sheet is changed where it is: its content
 * gets a transform in front and its boxes the new size, so its links,
 * bookmarks, tags and the rest of the document stay as they were. Several
 * per sheet draw each page as a form XObject (what pdf-lib's embedPage makes)
 * on a new sheet, and the old pages go.
 *
 * Form fields are flattened first: a field's box and its text would not
 * scale together, so a field would look different, or drift. Notes, links
 * and other annotations move and scale with their page, and links and
 * bookmarks to a page point at the same spot on it afterwards.
 */
import {
  PDFArray,
  PDFBool,
  PDFContentStream,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFDocument,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { friendlyPdfError } from "../errors";
import { drawFields } from "../forms";
import { openPdf } from "../open";
import { arrangePages, destinationEntry, namedDests } from "../operations";
import { pageFrame, visibleBox } from "../page-frame";
import { layout, type Placed, type ResizeOptions } from "./geometry";

export type { ResizeOptions } from "./geometry";

/** A PDF matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Matrix = [number, number, number, number, number, number];

/** `a`, then `b`. */
function then(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

function apply(m: Matrix, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** The turn part of `m` alone (its scale and shift taken out). */
function turnOf(m: Matrix): Matrix | undefined {
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const r: Matrix = [m[0] / s, m[1] / s, m[2] / s, m[3] / s, 0, 0];
  return Math.abs(r[0] - 1) < 1e-6 && Math.abs(r[1]) < 1e-6 && Math.abs(r[2]) < 1e-6 && Math.abs(r[3] - 1) < 1e-6 ? undefined : r;
}

/** A number for a content stream: no exponents, no long tails. */
const num = (n: number) => (Math.abs(n) < 1e-9 ? "0" : String(Math.round(n * 10000) / 10000));

/** From the page's own space to the sheet, for a page placed at `p` (its rotation turned into the content). */
function placement(page: PDFPage, p: Placed): Matrix {
  return then(invert(pageFrame(page).matrix), [p.scale, 0, 0, p.scale, p.x, p.y]);
}

const N = {
  Contents: PDFName.of("Contents"),
  Resources: PDFName.of("Resources"),
  MediaBox: PDFName.of("MediaBox"),
  CropBox: PDFName.of("CropBox"),
  Rotate: PDFName.of("Rotate"),
  Annots: PDFName.of("Annots"),
  Rect: PDFName.of("Rect"),
  RD: PDFName.of("RD"),
  InkList: PDFName.of("InkList"),
  AP: PDFName.of("AP"),
  Matrix: PDFName.of("Matrix"),
  F: PDFName.of("F"),
  P: PDFName.of("P"),
  D: PDFName.of("D"),
  First: PDFName.of("First"),
  Next: PDFName.of("Next"),
  Outlines: PDFName.of("Outlines"),
  OpenAction: PDFName.of("OpenAction"),
  NeedAppearances: PDFName.of("NeedAppearances"),
  Filter: PDFName.of("Filter"),
  DecodeParms: PDFName.of("DecodeParms"),
};
/** Flat lists of x, y pairs. */
const POINT_LISTS = ["QuadPoints", "Vertices", "L", "CL"].map((key) => PDFName.of(key));
const OTHER_BOXES = ["BleedBox", "TrimBox", "ArtBox"].map((key) => PDFName.of(key));
const NO_ROTATE = 1 << 4;

const numberAt = (arr: PDFArray, i: number) => {
  const v = arr.lookup(i);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};

/** Moves the x, y pairs of `arr` through `m`. */
function movePoints(arr: PDFArray, m: Matrix) {
  for (let i = 0; i + 1 < arr.size(); i += 2) {
    const x = numberAt(arr, i);
    const y = numberAt(arr, i + 1);
    if (x === undefined || y === undefined) continue;
    const p = apply(m, x, y);
    arr.set(i, PDFNumber.of(p.x));
    arr.set(i + 1, PDFNumber.of(p.y));
  }
}

/** The box around a rectangle [x1 y1 x2 y2] once moved through `m`. */
function moveRect(doc: PDFDocument, arr: PDFArray, m: Matrix): PDFArray | undefined {
  const v = [0, 1, 2, 3].map((i) => numberAt(arr, i));
  if (v.some((n) => n === undefined)) return undefined;
  const [x1, y1, x2, y2] = v as number[];
  const corners = [apply(m, x1, y1), apply(m, x2, y1), apply(m, x1, y2), apply(m, x2, y2)];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return doc.context.obj([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

/**
 * Moves an annotation with its page. Readers fit an annotation's picture
 * into its /Rect, so scaling the box scales the picture; a page that was
 * turned has its turn put into the picture, since the page itself is no
 * longer turned.
 */
function moveAnnotation(doc: PDFDocument, annot: PDFDict, m: Matrix, turned: Set<PDFStream>) {
  const rect = annot.lookup(N.Rect);
  if (rect instanceof PDFArray) {
    const moved = moveRect(doc, rect, m);
    if (moved) annot.set(N.Rect, moved);
  }
  for (const key of POINT_LISTS) {
    const list = annot.lookup(key);
    if (list instanceof PDFArray) movePoints(list, m);
  }
  const ink = annot.lookup(N.InkList);
  if (ink instanceof PDFArray) {
    for (let i = 0; i < ink.size(); i++) {
      const path = ink.lookup(i);
      if (path instanceof PDFArray) movePoints(path, m);
    }
  }
  // The inset between the box and the drawing scales with it.
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const rd = annot.lookup(N.RD);
  if (rd instanceof PDFArray) {
    for (let i = 0; i < rd.size(); i++) {
      const v = numberAt(rd, i);
      if (v !== undefined) rd.set(i, PDFNumber.of(v * scale));
    }
  }
  const turn = turnOf(m);
  const flags = annot.lookup(N.F);
  // A NoRotate note stays upright whichever way the page turns.
  if (!turn || (flags instanceof PDFNumber && flags.asNumber() & NO_ROTATE)) return;
  const ap = annot.lookup(N.AP);
  if (!(ap instanceof PDFDict)) return;
  for (const [, entry] of ap.entries()) {
    const value = doc.context.lookup(entry);
    const streams: PDFObject[] = value instanceof PDFDict ? [...value.values()].map((v) => doc.context.lookup(v)!) : [value!];
    for (const stream of streams) {
      if (!(stream instanceof PDFStream) || turned.has(stream)) continue;
      turned.add(stream);
      const old = stream.dict.lookup(N.Matrix);
      const before: Matrix =
        old instanceof PDFArray && old.size() === 6 ? ([0, 1, 2, 3, 4, 5].map((i) => numberAt(old, i) ?? 0) as Matrix) : [1, 0, 0, 1, 0, 0];
      stream.dict.set(N.Matrix, doc.context.obj(then(before, turn)));
    }
  }
}

/** A copy of `obj` down to the objects it points at, which stay shared. */
function copyDirect(doc: PDFDocument, obj: PDFObject): PDFObject {
  if (obj instanceof PDFDict) {
    const out = doc.context.obj({});
    for (const [key, value] of obj.entries()) out.set(key, copyDirect(doc, value));
    return out;
  }
  if (obj instanceof PDFArray) {
    const out = doc.context.obj([]);
    for (let i = 0; i < obj.size(); i++) out.push(copyDirect(doc, obj.get(i)));
    return out;
  }
  return obj;
}

/**
 * Makes the page's annotations its own: a list or an annotation another page
 * already has is copied, so moving it for this page leaves the other one
 * where it was (and it is never moved twice).
 */
function ownAnnotations(doc: PDFDocument, page: PDFPage, seen: Set<PDFObject>) {
  let annots = page.node.Annots();
  if (!annots) return;
  if (seen.has(annots)) {
    annots = doc.context.obj(annots.asArray());
    page.node.set(N.Annots, annots);
  }
  seen.add(annots);
  for (let i = 0; i < annots.size(); i++) {
    const annot = annots.lookup(i);
    if (!(annot instanceof PDFDict)) continue;
    if (seen.has(annot)) {
      const copy = copyDirect(doc, annot) as PDFDict;
      copy.set(N.P, page.ref);
      annots.set(i, doc.context.register(copy));
      seen.add(copy);
    } else seen.add(annot);
  }
}

/** Where a page went: the sheet it is on now and the transform onto it. */
interface Moved {
  sheet: PDFRef;
  m: Matrix;
  turned: boolean;
}

/**
 * Points links, bookmarks and named destinations to a moved page at the
 * same spot on its sheet. One with a position on a page that was turned
 * shows the whole sheet: "top" and "left" no longer mean the same edge.
 */
function moveDestinations(doc: PDFDocument, moved: Map<PDFRef, Moved>) {
  const done = new Set<PDFArray>();
  const fix = (dest: PDFObject | undefined) => {
    if (!(dest instanceof PDFArray) || done.has(dest)) return;
    done.add(dest);
    const target = dest.get(0);
    const to = target instanceof PDFRef ? moved.get(target) : undefined;
    if (!to) return;
    const kind = dest.lookup(1);
    const kindName = kind instanceof PDFName ? kind.decodeText() : "";
    const whole = (fit: "Fit" | "FitB") => {
      while (dest.size() > 1) dest.remove(dest.size() - 1);
      dest.push(PDFName.of(fit));
    };
    dest.set(0, to.sheet);
    const { m } = to;
    if (kindName === "XYZ") {
      const left = numberAt(dest, 2);
      const top = numberAt(dest, 3);
      if (to.turned && (left === undefined || top === undefined)) return whole("Fit");
      const p = apply(m, left ?? 0, top ?? 0);
      if (left !== undefined) dest.set(2, PDFNumber.of(p.x));
      if (top !== undefined) dest.set(3, PDFNumber.of(p.y));
    } else if (kindName === "FitH" || kindName === "FitBH") {
      const top = numberAt(dest, 2);
      if (to.turned) return whole(kindName === "FitH" ? "Fit" : "FitB");
      if (top !== undefined) dest.set(2, PDFNumber.of(apply(m, 0, top).y));
    } else if (kindName === "FitV" || kindName === "FitBV") {
      const left = numberAt(dest, 2);
      if (to.turned) return whole(kindName === "FitV" ? "Fit" : "FitB");
      if (left !== undefined) dest.set(2, PDFNumber.of(apply(m, left, 0).x));
    } else if (kindName === "FitR") {
      const corners = [2, 3, 4, 5].map((i) => numberAt(dest, i));
      if (corners.every((c) => c !== undefined)) {
        const box = moveRect(doc, doc.context.obj(corners as number[]), m)!;
        for (let i = 0; i < 4; i++) dest.set(i + 2, box.get(i));
      }
    }
  };
  const fromHolder = (holder: PDFDict) => {
    const entry = destinationEntry(holder);
    if (entry) fix(entry[0].lookup(entry[1]));
  };

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i);
      if (annot instanceof PDFDict) fromHolder(annot);
    }
  }
  const seen = new Set<PDFDict>();
  const walk = (parent: PDFDict) => {
    for (let ref = parent.get(N.First); ref; ) {
      const item = doc.context.lookup(ref);
      if (!(item instanceof PDFDict) || seen.has(item)) break;
      seen.add(item);
      fromHolder(item);
      walk(item);
      ref = item.get(N.Next);
    }
  };
  const outlines = doc.catalog.lookup(N.Outlines);
  if (outlines instanceof PDFDict) walk(outlines);
  for (const value of namedDests(doc).values()) {
    const dest = doc.context.lookup(value);
    fix(dest instanceof PDFDict ? dest.lookup(N.D) : dest);
  }
  const open = doc.catalog.lookup(N.OpenAction);
  fix(open instanceof PDFDict ? open.lookup(N.D) : open);
}

/**
 * Draws the form fields into their pages. When some value can't be drawn
 * with the standard font (Arabic, Greek, Cyrillic…) the fields stay as
 * they are, and move with their page like the other annotations.
 */
async function flattenForm(doc: PDFDocument) {
  const acroForm = doc.catalog.getAcroForm();
  if (!acroForm) return;
  try {
    const form = doc.getForm();
    if (!form.getFields().length) return;
    // Readers were asked to draw the fields themselves: their pictures may
    // be stale, or missing, so all of them are drawn afresh.
    if (acroForm.dict.lookup(N.NeedAppearances) === PDFBool.True) {
      for (const field of form.getFields()) form.markFieldAsDirty(field.ref);
    }
    acroForm.dict.delete(N.NeedAppearances);
    await drawFields(form, await doc.embedFont(StandardFonts.Helvetica));
    if (acroForm.dict.lookup(N.NeedAppearances)) return;
    form.flatten({ updateFieldAppearances: false });
  } catch {
    // A malformed form: what's left of it moves with the pages.
  }
}

/** The page's content as one form XObject, in the page's own space; undefined for an empty page. */
function pageForm(doc: PDFDocument, page: PDFPage): PDFRef | undefined {
  const { context } = doc;
  const contents = context.lookup(page.node.get(N.Contents));
  const streams = (contents instanceof PDFArray ? contents.asArray().map((s) => context.lookup(s)) : [contents]).filter(
    (s): s is PDFStream => s instanceof PDFStream
  );
  if (!streams.length) return undefined;
  const box = visibleBox(page);
  const dict = context.obj({
    Type: "XObject",
    Subtype: "Form",
    BBox: [box.x, box.y, box.x + box.width, box.y + box.height],
  });
  // By reference: pages that share their resources keep sharing them.
  const resources = page.node.getInheritableAttribute(N.Resources);
  if (resources) dict.set(N.Resources, resources);
  // One stream is used as it is, still compressed.
  if (streams.length === 1 && streams[0] instanceof PDFRawStream) {
    const raw = streams[0];
    for (const key of [N.Filter, N.DecodeParms]) {
      const value = raw.dict.get(key);
      if (value) dict.set(key, value);
    }
    return context.register(PDFRawStream.of(dict, raw.contents));
  }
  const parts = streams.map((s) => {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    if (s instanceof PDFContentStream) return s.getUnencodedContents();
    throw new Error("This file isn't a readable PDF.");
  });
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    joined[at + part.length] = 10;
    at += part.length + 1;
  }
  return context.register(context.flateStream(joined, Object.fromEntries(dict.entries().map(([k, v]) => [k.decodeText(), v]))));
}

const clipOps = (c: { x: number; y: number; width: number; height: number }) =>
  `${num(c.x)} ${num(c.y)} ${num(c.width)} ${num(c.height)} re W n`;

/** One page onto a sheet of its own, changed where it is. */
function resizeInPlace(
  doc: PDFDocument,
  page: PDFPage,
  sheet: { width: number; height: number },
  p: Placed,
  turned: Set<PDFStream>
): Moved {
  const { context } = doc;
  const m = placement(page, p);
  const moved: Moved = { sheet: page.ref, m, turned: pageFrame(page).rotation !== 0 };
  // Content outside its cell (filled, or bigger than the sheet) is hidden;
  // no `q` before it, so a stray `Q` in old content can't undo the move.
  const prefix = context.register(context.stream(`${clipOps(p.clip)} ${m.map(num).join(" ")} cm\n`));
  const old = page.node.get(N.Contents);
  const list = context.lookup(old);
  const items = list instanceof PDFArray ? list.asArray() : old ? [old] : [];
  page.node.set(N.Contents, context.obj([prefix, ...items]));
  // Resources may come from the page tree; the page keeps using them.
  const resources = page.node.getInheritableAttribute(N.Resources);
  if (resources && !page.node.get(N.Resources)) page.node.set(N.Resources, resources);
  const box = context.obj([0, 0, sheet.width, sheet.height]);
  page.node.set(N.MediaBox, box);
  page.node.set(N.CropBox, box);
  for (const key of OTHER_BOXES) page.node.delete(key);
  page.node.set(N.Rotate, PDFNumber.of(0));
  const annots = page.node.Annots();
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const annot = annots!.lookup(i);
    if (annot instanceof PDFDict) moveAnnotation(doc, annot, m, turned);
  }
  return moved;
}

/**
 * Resizes every page of `bytes`. Errors are messages for people. Stops on
 * `signal` between pages.
 */
export async function resizePdf(
  bytes: Uint8Array,
  opts: ResizeOptions,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<Uint8Array> {
  let doc: PDFDocument;
  let pages: PDFPage[];
  try {
    doc = await openPdf(bytes);
    // A header with no document after it opens, then fails here.
    pages = doc.getPages();
  } catch (err) {
    throw friendlyPdfError(err);
  }
  stopIfAborted(signal);
  if (!pages.length) throw new Error("This PDF has no pages.");
  await flattenForm(doc);
  const sheets = layout(
    pages.map((page) => {
      const { width, height } = pageFrame(page);
      return { width, height };
    }),
    opts
  );
  const moved = new Map<PDFRef, Moved>();
  const turned = new Set<PDFStream>();
  // Before anything moves, so a copy is taken of the note as it was.
  const seen = new Set<PDFObject>();
  for (const page of pages) ownAnnotations(doc, page, seen);
  const { context } = doc;

  if (opts.perSheet === 1) {
    sheets.forEach((sheet, i) => {
      stopIfAborted(signal);
      if (i % 20 === 0) onProgress?.(i / sheets.length, `Page ${i + 1} of ${sheets.length}`);
      const p = sheet.pages[0];
      moved.set(pages[p.page].ref, resizeInPlace(doc, pages[p.page], sheet, p, turned));
    });
    moveDestinations(doc, moved);
  } else {
    const first = pages.length;
    for (const [i, sheet] of sheets.entries()) {
      stopIfAborted(signal);
      onProgress?.(i / sheets.length, `Sheet ${i + 1} of ${sheets.length}`);
      const out = doc.addPage([sheet.width, sheet.height]);
      const xobjects = context.obj({});
      const annots = context.obj([]);
      let ops = "";
      for (const [k, p] of sheet.pages.entries()) {
        const page = pages[p.page];
        const m = placement(page, p);
        const form = pageForm(doc, page);
        if (form) {
          xobjects.set(PDFName.of(`P${k}`), form);
          ops += `q ${clipOps(p.clip)} ${m.map(num).join(" ")} cm /P${k} Do Q\n`;
        }
        const own = page.node.Annots();
        for (let a = 0; a < (own?.size() ?? 0); a++) {
          const ref = own!.get(a);
          const annot = context.lookup(ref);
          if (!(annot instanceof PDFDict)) continue;
          moveAnnotation(doc, annot, m, turned);
          annot.set(N.P, out.ref);
          annots.push(ref);
        }
        page.node.delete(N.Annots);
        moved.set(page.ref, { sheet: out.ref, m, turned: pageFrame(page).rotation !== 0 });
      }
      out.node.set(N.Resources, context.obj({ XObject: xobjects }));
      out.node.set(N.Contents, context.register(context.flateStream(ops)));
      if (annots.size()) out.node.set(N.Annots, annots);
    }
    moveDestinations(doc, moved);
    // Only the sheets stay; what only the old pages used goes with them.
    arrangePages(
      doc,
      sheets.map((_, i) => first + i)
    );
  }
  onProgress?.(1, "Saving");
  stopIfAborted(signal);
  return doc.save({ updateFieldAppearances: false });
}
