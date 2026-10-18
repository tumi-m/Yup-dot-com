import {
  PDFAcroTerminal,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectCopier,
  PDFPage,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  PDFString,
  degrees,
  type PDFObject,
  type PDFWidgetAnnotation,
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
const Names = PDFName.of("Names");
const S = PDFName.of("S");
const K = PDFName.of("K");
const Pg = PDFName.of("Pg");
const Obj = PDFName.of("Obj");
const Ref = PDFName.of("Ref");
const StructTreeRoot = PDFName.of("StructTreeRoot");
const ParentTree = PDFName.of("ParentTree");
const IDTree = PDFName.of("IDTree");
const PageLabels = PDFName.of("PageLabels");

/** The [key, value] pairs of a name tree (`kind` "Names") or a number tree ("Nums"). */
function treeEntries(doc: PDFDocument, node: PDFObject | undefined, kind: "Names" | "Nums") {
  const out: [PDFObject | undefined, PDFObject][] = [];
  const seen = new Set<PDFDict>();
  const walk = (node: PDFObject | undefined) => {
    const dict = doc.context.lookup(node);
    if (!(dict instanceof PDFDict) || seen.has(dict)) return;
    seen.add(dict);
    const pairs = dict.lookup(PDFName.of(kind));
    for (let i = 0; pairs instanceof PDFArray && i + 1 < pairs.size(); i += 2) out.push([pairs.lookup(i), pairs.get(i + 1)]);
    const kids = dict.lookup(PDFName.of("Kids"));
    for (let i = 0; kids instanceof PDFArray && i < kids.size(); i++) walk(kids.get(i));
  };
  walk(node);
  return out;
}

/** The document's named destinations: the /Names /Dests tree, and the older /Dests dictionary. */
function namedDests(doc: PDFDocument): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>();
  const names = doc.catalog.lookup(Names);
  if (names instanceof PDFDict) {
    for (const [key, value] of treeEntries(doc, names.get(Dests), "Names")) {
      if (key instanceof PDFString || key instanceof PDFHexString) out.set(key.decodeText(), value);
    }
  }
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

/** The annotations on a page. */
function annotationsOf(page: PDFPage): PDFDict[] {
  const annots = page.node.Annots();
  const out: PDFDict[] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const annot = annots!.lookup(i);
    if (annot instanceof PDFDict) out.push(annot);
  }
  return out;
}

/** Takes the widgets `gone` picks out of the form, and fields left with none. */
function dropFields(doc: PDFDocument, gone: (widget: PDFWidgetAnnotation) => boolean) {
  const acroForm = doc.catalog.getAcroForm();
  if (!acroForm) return;
  try {
    for (const [field] of acroForm.getAllFields()) {
      if (!(field instanceof PDFAcroTerminal)) continue;
      const widgets = field.getWidgets();
      const out = widgets.map(gone);
      if (!out.includes(true)) continue;
      if (!out.includes(false)) acroForm.removeField(field);
      else for (let i = widgets.length - 1; i >= 0; i--) if (out[i]) field.removeWidget(i);
    }
    // The calculation order would keep removed fields, and their values, in the file.
    const order = acroForm.dict.lookup(PDFName.of("CO"));
    if (order instanceof PDFArray) {
      const left = new Set(acroForm.getAllFields().map(([, ref]) => ref));
      for (let i = order.size() - 1; i >= 0; i--) if (!left.has(order.get(i) as PDFRef)) order.remove(i);
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

/** `order` names pages of `pages`, each at most once. */
function checkOrder(pages: PDFPage[], order: number[]) {
  if (new Set(order).size !== order.length || order.some((i) => !pages[i])) {
    throw new Error("Invalid page order.");
  }
}

/** Whether `order` keeps every page of `pages` where it was. */
const unmoved = (pages: PDFPage[], order: number[]) => order.length === pages.length && order.every((p, i) => p === i);

/** Keeps the given (0-indexed) pages, in that order, and drops the rest. */
function arrangePages(doc: PDFDocument, order: number[]) {
  const pages = doc.getPages();
  checkOrder(pages, order);
  const kept = new Set(order);
  const dropped = pages.filter((_, i) => !kept.has(i));
  const droppedRefs = new Set(dropped.map((p) => p.ref));
  if (dropped.length) {
    const onDropped = new Set(dropped.flatMap(annotationsOf));
    dropFields(doc, (w) => onDropped.has(w.dict) || droppedRefs.has(w.P() as PDFRef));
  }
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
  if (dropped.length) {
    const tags = readTags(doc);
    copyTags(doc, doc, tags, new Set(order.map((i) => pages[i].ref)), (obj) => obj, tags.refs);
  }
  // Page labels go by position.
  if (!unmoved(pages, order)) doc.catalog.delete(PageLabels);
  // What else still points at a dropped page (a named destination) now
  // points at nothing, which readers ignore; a page left outside the page
  // tree would read as page 1.
  for (const page of dropped) doc.context.delete(page.ref);
  dropUnreachable(doc);
}

/** The kids of a structure element: one object or an array of them. */
function kidsOf(holder: PDFDict): PDFObject[] {
  const kids = holder.get(K);
  const list = holder.context.lookup(kids);
  return list instanceof PDFArray ? list.asArray() : kids ? [kids] : [];
}

/** A document's tags (its structure tree), read once to copy them for any set of its pages. */
interface Tags {
  root?: PDFDict;
  /** The pages each element's content is on: the marked content and annotations under it. */
  pages: Map<PDFDict, Set<PDFRef>>;
  /** Each element's object number. */
  refs: Map<PDFDict, PDFRef>;
  /** The ParentTree: by key, a page's elements (by marked content number) or an annotation's. */
  parents: [PDFObject, (PDFObject | undefined)[] | PDFObject | undefined][];
  /** The IDTree: elements by ID. */
  ids: [PDFObject, PDFObject | undefined][];
  /** Elements something outside the tags points at, such as a bookmark (/SE). */
  pointedAt: PDFRef[];
}

function readTags(doc: PDFDocument): Tags {
  const root = doc.catalog.lookup(StructTreeRoot);
  const tags: Tags = { pages: new Map(), refs: new Map(), parents: [], ids: [], pointedAt: [] };
  if (!(root instanceof PDFDict)) return tags;
  tags.root = root;
  const visit = (kid: PDFObject, inherited?: PDFRef): Set<PDFRef> | undefined => {
    const el = doc.context.lookup(kid);
    if (!(el instanceof PDFDict) || !el.has(S)) return undefined;
    if (kid instanceof PDFRef) tags.refs.set(el, kid);
    const known = tags.pages.get(el);
    if (known) return known;
    const pages = new Set<PDFRef>();
    tags.pages.set(el, pages);
    const own = el.get(Pg);
    const page = own instanceof PDFRef ? own : inherited;
    for (const kid of kidsOf(el)) {
      const item = doc.context.lookup(kid);
      const below = visit(kid, page);
      if (below) below.forEach((p) => pages.add(p));
      else if (item instanceof PDFNumber && page) pages.add(page);
      else if (item instanceof PDFDict) {
        const at = item.get(Pg) ?? page;
        if (at instanceof PDFRef) pages.add(at);
      }
    }
    if (!pages.size && page) pages.add(page);
    return pages;
  };
  for (const kid of kidsOf(root)) visit(kid);

  const lookup = (value: PDFObject | undefined) => doc.context.lookup(value);
  for (const [key, value] of treeEntries(doc, root.get(ParentTree), "Nums")) {
    const list = lookup(value);
    if (key) tags.parents.push([key, list instanceof PDFArray ? list.asArray().map(lookup) : list]);
  }
  for (const [key, value] of treeEntries(doc, root.get(IDTree), "Names")) if (key) tags.ids.push([key, lookup(value)]);

  // Everything else, to find what points into the tags.
  const elements = new Set(tags.refs.values());
  const seen = new Set<PDFRef>();
  const tree = doc.catalog.get(StructTreeRoot);
  if (tree instanceof PDFRef) seen.add(tree);
  const pending: unknown[] = [doc.context.trailerInfo.Info];
  for (const [key, value] of doc.catalog.entries()) if (key !== StructTreeRoot) pending.push(value);
  while (pending.length) {
    const obj = pending.pop();
    if (obj instanceof PDFRef) {
      if (seen.has(obj)) continue;
      seen.add(obj);
      if (elements.has(obj)) tags.pointedAt.push(obj);
      else pending.push(doc.context.lookup(obj));
    } else if (obj instanceof PDFDict) pending.push(...obj.values());
    else if (obj instanceof PDFArray) pending.push(...obj.asArray());
    else if (obj instanceof PDFStream) pending.push(obj.dict);
  }
  return tags;
}

/**
 * Writes `from`'s tags into `into`, which can be the same document, for the
 * `kept` pages of `from` alone: what only other pages show, such as a
 * picture's alt text or a link's address, is left out. `copy` brings an
 * object of `from` into `into`. An element that stays gets the number
 * `numbers` gives it, if any: in the same document its own, in another the
 * one what points at it (a bookmark's /SE) was copied with. Those of the
 * elements left out are deleted, so what points at one points at nothing.
 */
function copyTags(
  from: PDFDocument,
  into: PDFDocument,
  tags: Tags,
  kept: Set<PDFRef>,
  copy: <T extends PDFObject>(obj: T) => T,
  numbers: Map<PDFDict, PDFRef>
) {
  const { root } = tags;
  if (!root) return;
  const made = new Map<PDFDict, PDFRef>();
  const { context } = into;
  const annots = new Set(into.getPages().flatMap(annotationsOf));
  // Written at the end, so the walk reads the elements as they were.
  const written: [PDFRef, PDFDict][] = [];
  const onKept = (page: PDFObject | undefined) => page instanceof PDFRef && kept.has(page);
  const showsKept = (el: PDFDict) => {
    for (const page of tags.pages.get(el) ?? []) if (kept.has(page)) return true;
    return false;
  };

  const kids = (holder: PDFDict, parent: PDFRef, page?: PDFRef): PDFObject[] => {
    const out: PDFObject[] = [];
    for (const kid of kidsOf(holder)) {
      const item = from.context.lookup(kid);
      if (item instanceof PDFDict && item.has(S)) {
        const ref = element(item, parent, page);
        if (ref) out.push(ref);
      } else if (item instanceof PDFNumber) {
        if (onKept(page)) out.push(item);
      } else if (item instanceof PDFDict && onKept(item.get(Pg) ?? page)) {
        // A link to a page left out is gone from the page that stays.
        const obj = item.get(Obj);
        if (obj instanceof PDFRef && from.context.lookup(obj) instanceof PDFDict && !annots.has(context.lookup(copy(obj)) as PDFDict)) {
          continue;
        }
        out.push(copy(kid));
      }
    }
    return out;
  };
  const element = (el: PDFDict, parent: PDFRef, inherited?: PDFRef): PDFRef | undefined => {
    if (!showsKept(el)) return undefined;
    const known = made.get(el);
    if (known) return known;
    const ref = numbers.get(el) ?? context.nextRef();
    made.set(el, ref);
    const own = el.get(Pg);
    const below = kids(el, ref, own instanceof PDFRef ? own : inherited);
    if (!below.length && kidsOf(el).length) {
      made.delete(el);
      return undefined;
    }
    const dict = context.obj({});
    for (const [key, value] of el.entries()) {
      // Its parent and kids are the copies'; /Ref can name elements left out.
      if (key === K || key === P || key === Ref || (key === Pg && !onKept(value))) continue;
      dict.set(key, copy(value));
    }
    dict.set(P, parent);
    if (below.length) dict.set(K, context.obj(below));
    written.push([ref, dict]);
    return ref;
  };

  const rootRef = context.nextRef();
  const tree = context.obj({});
  for (const [key, value] of root.entries()) {
    if (key !== K && key !== ParentTree && key !== IDTree) tree.set(key, copy(value));
  }
  const top = kids(root, rootRef);
  if (top.length) tree.set(K, context.obj(top));
  // Which element each piece of a page, and each annotation, belongs to.
  const stays = (el: PDFObject | undefined) => (el instanceof PDFDict ? made.get(el) : undefined);
  if (root.has(ParentTree)) {
    const nums: PDFObject[] = [];
    for (const [key, value] of tags.parents) {
      if (Array.isArray(value)) {
        if (value.some(stays)) nums.push(key, context.register(context.obj(value.map((v) => stays(v) ?? PDFNull))));
      } else {
        const el = stays(value);
        if (el) nums.push(key, el);
      }
    }
    tree.set(ParentTree, context.register(context.obj({ Nums: nums })));
  }
  const ids: PDFObject[] = [];
  for (const [key, value] of tags.ids) {
    const el = stays(value);
    if (el) ids.push(key, el);
  }
  if (ids.length) tree.set(IDTree, context.register(context.obj({ Names: ids })));
  for (const [el, ref] of numbers) if (!made.has(el)) context.delete(ref);
  for (const [ref, dict] of written) context.assign(ref, dict);
  context.assign(rootRef, tree);
  into.catalog.set(StructTreeRoot, rootRef);
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
 * What a part of a document keeps of its catalog besides its pages, tags,
 * named destinations and page labels. Its attachments, scripts and open
 * action stay behind.
 */
const PART_ENTRIES = ["Version", "Extensions", "PageLayout", "PageMode", "ViewerPreferences", "Lang", "Metadata", "MarkInfo", "OCProperties", "Outlines", "AcroForm", "Dests"];

/**
 * Copies parts of `src` out of it as extractFrom does, for Split, which reads
 * the file once for all its parts: what every part needs of `src` (its tags)
 * is read once too.
 */
export function extractorFor(src: PDFDocument): (order: number[]) => Promise<Uint8Array> {
  const tags = readTags(src);
  return (order) => extractPart(src, tags, order);
}

/**
 * A document with the given (0-indexed) pages of `src`, in that order, copied
 * out of `src` and leaving it as it is. Like extractPages, it keeps the form
 * fields, bookmarks, links, layers, tags and title that go with its pages;
 * but it is built from only what those pages use, so nothing of the pages
 * left out comes along (such as the alt text and link addresses in their
 * tags), nor do the document's attachments and scripts.
 */
export async function extractFrom(src: PDFDocument, order: number[]): Promise<Uint8Array> {
  return extractorFor(src)(order);
}

async function extractPart(src: PDFDocument, tags: Tags, order: number[]): Promise<Uint8Array> {
  const srcPages = src.getPages();
  checkOrder(srcPages, order);
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.context.header = src.context.header;
  const copier = PDFObjectCopier.for(src.context, doc.context);
  const copy = <T extends PDFObject>(obj: T) => copier.copy(obj);
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
  // Nor are the tags, which copyTags writes for these pages alone. What
  // points at an element (a bookmark's /SE) gets the number it has if it stays.
  const structTree = src.catalog.get(StructTreeRoot);
  if (structTree instanceof PDFRef) copied.set(structTree, PDFNull);
  const numbers = new Map<PDFDict, PDFRef>();
  for (const ref of tags.pointedAt) {
    const number = doc.context.nextRef();
    copied.set(ref, number);
    numbers.set(src.context.lookup(ref, PDFDict), number);
  }
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
  // The rest of the document: title, form, bookmarks, named destinations, layers.
  for (const key of PART_ENTRIES) {
    const value = src.catalog.get(PDFName.of(key));
    if (value) doc.catalog.set(PDFName.of(key), copy(value));
  }
  const names = src.catalog.lookup(Names);
  const dests = names instanceof PDFDict ? names.get(Dests) : undefined;
  if (dests) doc.catalog.set(Names, doc.context.obj({ Dests: copy(dests) }));
  // Page labels go by position.
  const labels = src.catalog.get(PageLabels);
  if (labels && unmoved(srcPages, order)) doc.catalog.set(PageLabels, copy(labels));
  const { Info, ID } = src.context.trailerInfo;
  if (Info) doc.context.trailerInfo.Info = copy(Info);
  if (ID) doc.context.trailerInfo.ID = copy(ID);

  if (kept.size < srcPages.length) {
    dropLinksTo(doc, new Set([gone]));
    const onPages = new Set(doc.getPages().flatMap(annotationsOf));
    dropFields(doc, (w) => !onPages.has(w.dict));
  }
  copyTags(src, doc, tags, new Set(order.map((i) => srcPages[i].ref)), copy, numbers);
  dropXfa(doc);
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
