import {
  PDFAcroTerminal,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFPage,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  PDFString,
  degrees,
  type PDFObject,
} from "pdf-lib";
import { openPdf } from "./open";
import { ENCRYPTED_MESSAGE, friendlyPdfError } from "./errors";

/**
 * Structural page operations. Annotation flattening lives in `bake.ts`.
 *
 * Pages are moved and removed inside the document itself rather than copied
 * into a new one, so its form fields, bookmarks and metadata stay.
 */

export async function loadPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  return openPdf(bytes);
}

/** Number of pages in a document. */
export async function getPageCount(bytes: ArrayBuffer | Uint8Array): Promise<number> {
  const doc = await openPdf(bytes);
  return doc.getPageCount();
}

/**
 * Number of pages in a PDF for the cloud library, which keeps the file as it
 * is. One that an owner password only restricts opens without a password,
 * so it is counted; one that needs a password to open is refused. Errors are
 * messages for people (lib/pdf/errors.ts).
 */
export async function pageCountToStore(bytes: Uint8Array): Promise<number> {
  try {
    return await getPageCount(bytes);
  } catch (err) {
    if (!/encrypted/i.test(err instanceof Error ? err.message : "")) throw friendlyPdfError(err);
  }
  try {
    const { pageCountWithoutPassword } = await import("./security");
    return await pageCountWithoutPassword(bytes);
  } catch {
    throw new Error(ENCRYPTED_MESSAGE);
  }
}

const Widget = PDFName.of("Widget");
const P = PDFName.of("P");
const T = PDFName.of("T");
const Parent = PDFName.of("Parent");
const Dest = PDFName.of("Dest");
const Dests = PDFName.of("Dests");
const A = PDFName.of("A");
const D = PDFName.of("D");
const GoTo = PDFName.of("GoTo");
const First = PDFName.of("First");
const Last = PDFName.of("Last");
const Next = PDFName.of("Next");
const Prev = PDFName.of("Prev");
const Count = PDFName.of("Count");

/** The document's named destinations: the /Names /Dests tree, and the older /Dests dictionary. */
function namedDests(doc: PDFDocument): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>();
  const seen = new Set<PDFDict>();
  const walk = (node: PDFObject | undefined) => {
    const dict = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (!(dict instanceof PDFDict) || seen.has(dict)) return;
    seen.add(dict);
    const names = dict.lookup(PDFName.of("Names"));
    for (let i = 0; names instanceof PDFArray && i + 1 < names.size(); i += 2) {
      const key = names.lookup(i);
      if (key instanceof PDFString || key instanceof PDFHexString) out.set(key.decodeText(), names.get(i + 1));
    }
    const kids = dict.lookup(PDFName.of("Kids"));
    for (let i = 0; kids instanceof PDFArray && i < kids.size(); i++) walk(kids.get(i));
  };
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) walk(names.get(Dests));
  const old = doc.catalog.lookup(Dests);
  if (old instanceof PDFDict) {
    for (const [key, value] of old.entries()) if (!out.has(key.decodeText())) out.set(key.decodeText(), value);
  }
  return out;
}

/** The dictionary and key holding a link's or bookmark's destination: its /Dest, or its GoTo action's /D. */
function destinationEntry(holder: PDFDict): [PDFDict, PDFName] | undefined {
  if (holder.has(Dest)) return [holder, Dest];
  const action = holder.lookup(A);
  if (action instanceof PDFDict && action.lookup(PDFName.of("S")) === GoTo) return [action, D];
}

/** A destination as [page, /XYZ …], with a named one looked up in `doc`. */
function explicitDest(doc: PDFDocument, dest: PDFObject | undefined, named: () => Map<string, PDFObject>): PDFArray | undefined {
  if (dest instanceof PDFName || dest instanceof PDFString || dest instanceof PDFHexString) {
    dest = doc.context.lookup(named().get(dest.decodeText()));
    if (dest instanceof PDFDict) dest = dest.lookup(D);
  }
  return dest instanceof PDFArray ? dest : undefined;
}

/** Where a link or bookmark goes in its own document. */
function destination(doc: PDFDocument, holder: PDFDict, named: () => Map<string, PDFObject>): PDFArray | undefined {
  const entry = destinationEntry(holder);
  return entry && explicitDest(doc, entry[0].lookup(entry[1]), named);
}

/** `make()`, run once and only when asked for. */
function once<T>(make: () => T): () => T {
  let value: { v: T } | undefined;
  return () => (value ??= { v: make() }).v;
}

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

/**
 * Takes the widgets on dropped pages out of the form, and fields left with
 * none. A widget is on one when a dropped page lists it (`onDropped`) or it
 * names one as its page (`droppedRefs`).
 */
function dropFields(doc: PDFDocument, onDropped: Set<PDFDict>, droppedRefs: Set<PDFRef>) {
  const acroForm = doc.catalog.getAcroForm();
  if (!acroForm || !droppedRefs.size) return;
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

/**
 * An XFA form draws its own pages, which no longer match once pages move:
 * readers that use it (Acrobat) would show the old ones.
 */
function dropXfa(doc: PDFDocument) {
  doc.catalog.getAcroForm()?.dict.delete(PDFName.of("XFA"));
  doc.catalog.delete(PDFName.of("NeedsRendering"));
}

/** Keeps the given (0-indexed) pages, in that order, and drops the rest. */
function arrangePages(doc: PDFDocument, order: number[]) {
  const pages = doc.getPages();
  if (new Set(order).size !== order.length || order.some((i) => !pages[i])) {
    throw new Error("Invalid page order.");
  }
  const kept = new Set(order);
  const dropped = pages.filter((_, i) => !kept.has(i));
  const droppedRefs = new Set(dropped.map((p) => p.ref));
  const onDropped = new Set<PDFDict>();
  for (const page of dropped) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i);
      if (annot instanceof PDFDict) onDropped.add(annot);
    }
  }
  dropFields(doc, onDropped, droppedRefs);
  dropXfa(doc);
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
  dropLinksTo(doc, droppedRefs);
  // What else still points at a dropped page (a named destination) now
  // points at nothing, which readers ignore; a page left outside the page
  // tree would read as page 1.
  for (const page of dropped) doc.context.delete(page.ref);
  dropUnreachable(doc);
}

/**
 * Takes out the links and bookmarks that lead to the `gone` pages. A dropped
 * bookmark's own entries move up in its place.
 */
function dropLinksTo(doc: PDFDocument, gone: Set<PDFRef>) {
  if (!gone.size) return;
  const named = once(() => namedDests(doc));
  const leadsAway = (holder: PDFDict) => {
    const target = destination(doc, holder, named)?.get(0);
    return target instanceof PDFRef && gone.has(target);
  };
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    for (let i = (annots?.size() ?? 0) - 1; i >= 0; i--) {
      const annot = annots!.lookup(i);
      if (annot instanceof PDFDict && annot.get(PDFName.of("Subtype")) === PDFName.of("Link") && leadsAway(annot)) {
        annots!.remove(i);
      }
    }
  }

  const rootRef = doc.catalog.get(PDFName.of("Outlines"));
  const root = doc.context.lookup(rootRef);
  if (!(rootRef instanceof PDFRef) || !(root instanceof PDFDict)) return;
  const seen = new Set<PDFDict>();
  /** The entries that stay under `parent`, each with its own entries sorted out. */
  const kept = (parent: PDFDict): PDFRef[] => {
    const out: PDFRef[] = [];
    for (let ref = parent.get(First); ref instanceof PDFRef; ) {
      const item = doc.context.lookup(ref);
      if (!(item instanceof PDFDict) || seen.has(item)) break;
      seen.add(item);
      const next = item.get(Next);
      if (leadsAway(item)) out.push(...kept(item));
      else {
        relink(ref, item, kept(item));
        out.push(ref);
      }
      ref = next;
    }
    return out;
  };
  /** Puts `kids` under `parent`, and counts the entries that show when it is open. */
  const relink = (parentRef: PDFRef, parent: PDFDict, kids: PDFRef[]) => {
    let shown = 0;
    kids.forEach((ref, i) => {
      const item = doc.context.lookup(ref, PDFDict);
      item.set(Parent, parentRef);
      if (i > 0) item.set(Prev, kids[i - 1]);
      else item.delete(Prev);
      if (i < kids.length - 1) item.set(Next, kids[i + 1]);
      else item.delete(Next);
      const count = item.lookup(Count);
      shown += 1 + (count instanceof PDFNumber && count.asNumber() > 0 ? count.asNumber() : 0);
    });
    if (!kids.length) {
      for (const key of [First, Last, Count]) parent.delete(key);
      return;
    }
    parent.set(First, kids[0]);
    parent.set(Last, kids[kids.length - 1]);
    // Negative for a closed entry; the outline itself is always open.
    const count = parent.lookup(Count);
    if (parent === root) parent.set(Count, PDFNumber.of(shown));
    else if (count instanceof PDFNumber && count.asNumber()) parent.set(Count, PDFNumber.of(count.asNumber() < 0 ? -shown : shown));
  };
  relink(rootRef, root, kept(root));
}

/**
 * Copies all of `src`'s pages into `doc` (not yet in its page list).
 * pdf-lib's copyPages also copies each page a link or widget points to,
 * whole and outside the page tree: one page brings the document along, and
 * the links lead to those loose copies, which read as page 1. Here they lead
 * to the copied pages, and a link to a named destination gets the place it
 * names, as `src`'s names don't come along.
 */
function copyAllPages(doc: PDFDocument, src: PDFDocument): { pages: PDFPage[]; copier: PDFObjectCopier } {
  const copier = PDFObjectCopier.for(src.context, doc.context);
  // Each page gets its number in `doc` first, so a reference to it is copied as one to its copy.
  const copied = (copier as unknown as { traversedObjects: Map<PDFObject, PDFObject> }).traversedObjects;
  const srcPages = src.getPages();
  const refs = srcPages.map((page) => {
    const ref = doc.context.nextRef();
    copied.set(page.ref, ref);
    return ref;
  });
  const pages = srcPages.map((page, i) => {
    const node = copier.copy(page.node);
    doc.context.assign(refs[i], node);
    return PDFPage.of(node, refs[i], doc);
  });

  const named = once(() => namedDests(src));
  for (const page of pages) {
    const annots = page.node.Annots();
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i);
      const entry = annot instanceof PDFDict ? destinationEntry(annot) : undefined;
      if (!entry) continue;
      const [holder, key] = entry;
      const name = holder.lookup(key);
      if (!(name instanceof PDFName || name instanceof PDFString || name instanceof PDFHexString)) continue;
      const dest = explicitDest(src, name, named);
      if (dest) holder.set(key, copier.copy(dest));
    }
  }
  return { pages, copier };
}

/** Adds `src`'s layers (optional content) to `doc`, each shown or hidden as it was. */
function adoptLayers(doc: PDFDocument, src: PDFDocument, copier: PDFObjectCopier) {
  const OCProperties = PDFName.of("OCProperties");
  const from = src.catalog.lookup(OCProperties);
  const groups = from instanceof PDFDict ? from.lookup(PDFName.of("OCGs")) : undefined;
  if (!(from instanceof PDFDict) || !(groups instanceof PDFArray)) return;
  const into = doc.catalog.lookup(OCProperties);
  if (!(into instanceof PDFDict)) {
    doc.catalog.set(OCProperties, copier.copy(src.catalog.get(OCProperties)!));
    return;
  }
  const list = (dict: PDFObject | undefined, key: string) => {
    const value = dict instanceof PDFDict ? dict.lookup(PDFName.of(key)) : undefined;
    return value instanceof PDFArray ? value : undefined;
  };
  const config = from.lookup(D);
  const hiddenFirst = config instanceof PDFDict && config.lookup(PDFName.of("BaseState")) === PDFName.of("OFF");
  const on = list(config, "ON")?.asArray() ?? [];
  const off = list(config, "OFF")?.asArray() ?? [];

  const existing = into.lookup(D);
  const targetConfig = existing instanceof PDFDict ? existing : doc.context.obj({});
  if (targetConfig !== existing) into.set(D, targetConfig);
  const add = (dict: PDFDict, key: string, value: PDFObject) => {
    let array = list(dict, key);
    if (!array) dict.set(PDFName.of(key), (array = doc.context.obj([])));
    array.push(value);
  };
  const targetHides = targetConfig.lookup(PDFName.of("BaseState")) === PDFName.of("OFF");
  for (const group of groups.asArray()) {
    const shown = hiddenFirst ? on.includes(group) : !off.includes(group);
    const ref = copier.copy(group);
    add(into, "OCGs", ref);
    if (shown && targetHides) add(targetConfig, "ON", ref);
    if (!shown && !targetHides) add(targetConfig, "OFF", ref);
  }
  // The layers panel lists what /Order names, so the new layers join it.
  const order = list(config, "Order");
  const targetOrder = list(targetConfig, "Order");
  if (order && targetOrder) for (const item of order.asArray()) targetOrder.push(copier.copy(item));
}

/** Adds the form fields on `pages` (just copied from `src`) to `doc`'s form, renaming clashes. */
function adoptFields(doc: PDFDocument, src: PDFDocument, pages: PDFPage[], copier: PDFObjectCopier) {
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
  for (const key of ["DA", "DR", "NeedAppearances"]) {
    const value = srcForm.dict.get(PDFName.of(key));
    if (value && !form.dict.has(PDFName.of(key))) form.dict.set(PDFName.of(key), copier.copy(value));
  }
}

/**
 * Adds the pages of `others` after `first`'s, with their links, form fields
 * and layers. `first` stays the document: its title, form, bookmarks and
 * named destinations carry over.
 */
export async function mergeDocuments(first: PDFDocument, others: PDFDocument[]): Promise<Uint8Array> {
  if (others.length) dropXfa(first);
  for (const src of others) {
    const { pages, copier } = copyAllPages(first, src);
    pages.forEach((p) => first.addPage(p));
    adoptFields(first, src, pages, copier);
    adoptLayers(first, src, copier);
  }
  dropUnreachable(first);
  return first.save();
}

/** Merge multiple PDFs (as byte arrays) into a single document. */
export async function mergePdfs(parts: (ArrayBuffer | Uint8Array)[]): Promise<Uint8Array> {
  if (!parts.length) return (await PDFDocument.create()).save();
  const docs: PDFDocument[] = [];
  for (const part of parts) docs.push(await openPdf(part));
  return mergeDocuments(docs[0], docs.slice(1));
}

/**
 * Keep the given (0-indexed) pages, in the order given, and drop the rest.
 * Backs both "extract" and "reorder".
 */
export async function extractPages(
  bytes: ArrayBuffer | Uint8Array,
  pageIndices: number[]
): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  arrangePages(doc, pageIndices);
  return doc.save();
}

/**
 * A document with the given (0-indexed) pages of `src`, in that order, made
 * as extractPages makes it, but copied out of `src` and leaving it as it is:
 * Split reads the file once for all its parts, instead of reading the whole
 * file again for each one.
 */
export async function extractFrom(src: PDFDocument, order: number[]): Promise<Uint8Array> {
  const srcPages = src.getPages();
  if (new Set(order).size !== order.length || order.some((i) => !srcPages[i])) {
    throw new Error("Invalid page order.");
  }
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.context.header = src.context.header;
  const copier = PDFObjectCopier.for(src.context, doc.context);
  const copied = (copier as unknown as { traversedObjects: Map<PDFObject, PDFObject> }).traversedObjects;
  // Anything that points at the catalog or page tree gets the new ones, not copies.
  copied.set(src.context.trailerInfo.Root!, doc.context.trailerInfo.Root!);
  const tree = src.catalog.get(PDFName.of("Pages"));
  if (tree) copied.set(tree, doc.catalog.get(PDFName.of("Pages"))!);
  // What points at a page left out points at nothing, which readers ignore,
  // and the page itself is never copied.
  const kept = new Set(order);
  const gone = doc.context.nextRef();
  srcPages.forEach((page, i) => {
    if (!kept.has(i)) copied.set(page.ref, gone);
  });
  const refs = order.map((i) => {
    const ref = doc.context.nextRef();
    copied.set(srcPages[i].ref, ref);
    return ref;
  });
  // The copier gives each page what it inherits from the page tree.
  order.forEach((i, k) => {
    const node = copier.copy(srcPages[i].node) as PDFPageLeaf;
    doc.context.assign(refs[k], node);
    doc.addPage(PDFPage.of(node, refs[k], doc));
  });
  // The rest of the document: title, form, bookmarks, names, layers.
  for (const [key, value] of src.catalog.entries()) {
    if (key !== PDFName.of("Pages")) doc.catalog.set(key, copier.copy(value));
  }
  const { Info, ID } = src.context.trailerInfo;
  if (Info) doc.context.trailerInfo.Info = copier.copy(Info);
  if (ID) doc.context.trailerInfo.ID = copier.copy(ID);

  const droppedRefs = new Set(kept.size < srcPages.length ? [gone] : []);
  const onDropped = new Set<PDFDict>();
  if (droppedRefs.size && doc.catalog.getAcroForm()) {
    srcPages.forEach((page, i) => {
      const annots = kept.has(i) ? undefined : page.node.Annots();
      for (let a = 0; a < (annots?.size() ?? 0); a++) {
        const copy = copied.get(annots!.get(a));
        const annot = copy instanceof PDFRef ? doc.context.lookup(copy) : copy;
        if (annot instanceof PDFDict) onDropped.add(annot);
      }
    });
  }
  dropFields(doc, onDropped, droppedRefs);
  dropXfa(doc);
  dropLinksTo(doc, droppedRefs);
  dropUnreachable(doc);
  return doc.save();
}

/** Delete the given (0-indexed) pages. */
export async function deletePages(
  bytes: ArrayBuffer | Uint8Array,
  pagesToDelete: number[]
): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
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
  const doc = await openPdf(bytes);
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
