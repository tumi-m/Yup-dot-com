import {
  PDFAcroTerminal,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObjectCopier,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  PDFString,
  degrees,
  type PDFPage,
} from "pdf-lib";

/**
 * Structural page operations. Annotation flattening lives in `bake.ts`.
 *
 * Pages are moved and removed inside the document itself rather than copied
 * into a new one, so its form fields, bookmarks and metadata stay.
 */

export async function loadPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes);
}

/** Number of pages in a document. */
export async function getPageCount(bytes: ArrayBuffer | Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

const Widget = PDFName.of("Widget");
const P = PDFName.of("P");
const T = PDFName.of("T");
const Parent = PDFName.of("Parent");

/** Drops objects nothing refers to any more, so removed pages leave nothing behind in the file. */
function dropUnreachable(doc: PDFDocument) {
  const { context } = doc;
  const reached = new Set<PDFRef>();
  const pending: unknown[] = [context.trailerInfo.Root, context.trailerInfo.Info];
  while (pending.length) {
    const obj = pending.pop();
    if (obj instanceof PDFRef) {
      if (reached.has(obj)) continue;
      reached.add(obj);
      pending.push(context.lookup(obj));
    } else if (obj instanceof PDFDict) pending.push(...obj.values());
    else if (obj instanceof PDFArray) pending.push(...obj.asArray());
    else if (obj instanceof PDFStream) pending.push(obj.dict);
  }
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reached.has(ref)) context.delete(ref);
  }
}

/** Takes the widgets on `dropped` pages out of the form, and fields left with none. */
function dropFields(doc: PDFDocument, dropped: PDFPage[]) {
  const acroForm = doc.catalog.getAcroForm();
  if (!acroForm || !dropped.length) return;
  const droppedRefs = new Set(dropped.map((p) => p.ref));
  const onDropped = new Set<PDFDict>();
  for (const page of dropped) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i);
      if (annot instanceof PDFDict) onDropped.add(annot);
    }
  }
  try {
    for (const [field] of acroForm.getAllFields()) {
      if (!(field instanceof PDFAcroTerminal)) continue;
      const widgets = field.getWidgets();
      const gone = widgets.map((w) => onDropped.has(w.dict) || droppedRefs.has(w.P() as PDFRef));
      if (!gone.includes(true)) continue;
      if (!gone.includes(false)) acroForm.removeField(field);
      else for (let i = widgets.length - 1; i >= 0; i--) if (gone[i]) field.removeWidget(i);
    }
  } catch {
    // A malformed form must not stop the page operation.
  }
}

/** Keeps the given (0-indexed) pages, in that order, and drops the rest. */
function arrangePages(doc: PDFDocument, order: number[]) {
  const pages = doc.getPages();
  if (new Set(order).size !== order.length || order.some((i) => !pages[i])) {
    throw new Error("Invalid page order.");
  }
  const kept = new Set(order);
  const dropped = pages.filter((_, i) => !kept.has(i));
  dropFields(doc, dropped);
  for (const page of pages) {
    // A page can inherit its size, rotation and resources from the page
    // tree; give it its own copy before it moves.
    for (const key of PDFPageLeaf.InheritableEntries) {
      const name = PDFName.of(key);
      const value = page.node.getInheritableAttribute(name);
      if (value && !page.node.get(name)) page.node.set(name, value);
    }
  }
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
  for (const i of order) doc.addPage(pages[i]);
  // Empty dropped pages, in case a bookmark or link still points at one.
  for (const page of dropped) {
    for (const key of page.node.keys()) if (key !== PDFName.Type) page.node.delete(key);
  }
  dropUnreachable(doc);
}

/** Adds the form fields on `pages` (just copied from `src`) to `doc`'s form, renaming clashes. */
function adoptFields(doc: PDFDocument, src: PDFDocument, pages: PDFPage[]) {
  const srcForm = src.catalog.getAcroForm();
  if (!srcForm) return;
  const form = doc.catalog.getOrCreateAcroForm();
  const nameOf = (dict: PDFDict) => {
    const t = dict.lookup(T);
    return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : "";
  };
  const taken = new Set(form.getFields().map(([, ref]) => nameOf(doc.context.lookup(ref, PDFDict))));
  const roots = new Set<PDFRef>();
  for (const page of pages) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const widgetRef = annots!.get(i);
      const widget = annots!.lookup(i);
      if (!(widgetRef instanceof PDFRef) || !(widget instanceof PDFDict)) continue;
      if (widget.get(PDFName.of("Subtype")) !== Widget) continue;
      // The copied widget still points at the source page.
      if (widget.has(P)) widget.set(P, page.ref);
      let ref: PDFRef = widgetRef;
      let dict: PDFDict = widget;
      for (let up = dict.get(Parent); up instanceof PDFRef; up = dict.get(Parent)) {
        ref = up;
        dict = doc.context.lookup(up, PDFDict);
      }
      if (dict.has(T)) roots.add(ref);
    }
  }
  for (const ref of roots) {
    const dict = doc.context.lookup(ref, PDFDict);
    const base = nameOf(dict);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    if (name !== base) dict.set(T, PDFHexString.fromText(name));
    taken.add(name);
    form.addField(ref);
  }
  // Defaults the fields fall back on (font, size), unless `doc` has its own.
  const copier = PDFObjectCopier.for(src.context, doc.context);
  for (const key of ["DA", "DR", "NeedAppearances"]) {
    const value = srcForm.dict.get(PDFName.of(key));
    if (value && !form.dict.has(PDFName.of(key))) form.dict.set(PDFName.of(key), copier.copy(value));
  }
}

/** Merge multiple PDFs (as byte arrays) into a single document. */
export async function mergePdfs(parts: (ArrayBuffer | Uint8Array)[]): Promise<Uint8Array> {
  if (!parts.length) return (await PDFDocument.create()).save();
  const out = await PDFDocument.load(parts[0]);
  for (const part of parts.slice(1)) {
    const src = await PDFDocument.load(part);
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    adoptFields(out, src, copied);
  }
  dropUnreachable(out);
  return out.save();
}

/**
 * Keep the given (0-indexed) pages, in the order given, and drop the rest.
 * Backs both "extract" and "reorder".
 */
export async function extractPages(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  arrangePages(doc, pageIndices);
  return doc.save();
}

/** Delete the given (0-indexed) pages. */
export async function deletePages(
  bytes: ArrayBuffer | Uint8Array,
  pagesToDelete: number[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const remove = new Set(pagesToDelete);
  arrangePages(doc, doc.getPageIndices().filter((i) => !remove.has(i)));
  return doc.save();
}

/** Rotate specific pages by a relative multiple of 90 degrees. */
export async function rotatePages(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[],
  delta: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const targets = new Set(pageIndices);
  doc.getPages().forEach((page, i) => {
    if (targets.has(i)) {
      page.setRotation(degrees((page.getRotation().angle + delta + 360) % 360));
    }
  });
  return doc.save();
}

/** Reorder pages given a full ordering of (0-indexed) positions. */
export async function reorderPages(
  bytes: ArrayBuffer | Uint8Array,
  newOrder: number[]
): Promise<Uint8Array> {
  return extractPages(bytes, newOrder);
}
