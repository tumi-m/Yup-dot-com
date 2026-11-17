/**
 * Repair, the part pdf-lib does: the salvaged file is read object by object
 * (pdf-lib reads every object in the file in turn, so a wrong or missing
 * index doesn't stop it), its page list is rebuilt from what is there, and
 * each page is checked: one whose content and resources can all be read is
 * copied as it is, with its text, links, fields and bookmarks; one that
 * can't is left for pdf.js to draw as a picture (see ./pictures.ts).
 *
 * Pure TypeScript on pdf-lib, so it runs in a worker and in Node tests.
 */
import {
  PDFArray,
  PDFCatalog,
  PDFDict,
  PDFDocument,
  PDFInvalidObject,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFPageLeaf,
  PDFPageTree,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";
import { Inflate, Unzlib } from "fflate";
import { arrangePages, dropFieldsOffPages, dropUnreachable, extractFrom } from "../operations";
import { salvage, type ByteFix } from "./salvage";
import { unpackObjectStreams } from "./object-streams";
import { stopIfAborted } from "../../abort";

/** What was wrong with the file and fixed: its bytes, its object streams ("objects") or its page list ("pages"). */
export type Fix = ByteFix | "objects" | "pages";

/** How each page of the repaired file is made: copied as it was, or drawn as a picture. */
export interface Slot {
  kind: "vector" | "picture";
  /** Cut off part way: only the start of its content is there. */
  partial?: boolean;
  /** Draws something: a page copied with no content at all is empty. */
  shows?: boolean;
}

/** What a document holds besides its pages. */
export interface Extras {
  fields: number;
  bookmarks: number;
}

export type Rebuilt =
  /** Every page copied as it was: the repaired file is ready. */
  | { kind: "done"; bytes: Uint8Array; slots: Slot[]; declared: number; fixes: Fix[]; before: Extras; after: Extras }
  /**
   * Some pages need pictures: `render` holds those pages for pdf.js, page
   * `renderPages[k]` (1-based) for the k-th of them; `vector` the whole
   * document, with those pages left empty for the pictures (see splicePictures).
   */
  | { kind: "pictures"; vector: Uint8Array; render: Uint8Array; renderPages: number[]; slots: Slot[]; declared: number; fixes: Fix[]; before: Extras }
  /** pdf-lib can't read it (or can't decrypt it): pdf.js gets the salvaged bytes. */
  | { kind: "unread"; bytes: Uint8Array; fixes: Fix[]; encrypted: boolean };

const N = PDFName.of;
const Type = N("Type");
const Page = N("Page");
const Pages = N("Pages");
const Kids = N("Kids");
const Count = N("Count");
const Parent = N("Parent");
const Contents = N("Contents");
const Resources = N("Resources");
const MediaBox = N("MediaBox");
const Annots = N("Annots");
const Filter = N("Filter");
const FlateDecode = N("FlateDecode");
const INHERITED = ["Resources", "MediaBox", "CropBox", "Rotate"].map(N);

/** Readers draw a page with no size as US Letter. */
const LETTER = [0, 0, 612, 792];
const MAX_DEPTH = 64;

type Progress = (fraction: number, label: string) => void;

interface Leaf {
  ref: PDFRef;
  dict: PDFDict;
}

/** The value of `key` where a page tree node has it, or what it inherits. */
type Inherited = Map<PDFName, PDFObject>;

/**
 * The document's pages, from its page tree: each page once, in order, given
 * what it inherits from the tree. A loop, a missing node or something that
 * isn't a page is stepped over. A tree that yields nothing is replaced by
 * every page object in the file, in object number order.
 */
function collectPages(doc: PDFDocument): { leaves: Leaf[]; broken: boolean; declared: number } {
  const { context } = doc;
  const leaves: Leaf[] = [];
  const seen = new Set<PDFObject>();
  let broken = false;
  let declared = 0;

  const asLeaf = (raw: PDFObject, node: PDFDict, inherited: Inherited) => {
    for (const [key, value] of inherited) if (!node.has(key)) node.set(key, value);
    leaves.push({ ref: raw instanceof PDFRef ? raw : context.register(node), dict: node });
  };
  const walk = (raw: PDFObject | undefined, inherited: Inherited, depth: number) => {
    const node = raw === undefined ? undefined : context.lookup(raw);
    if (!(node instanceof PDFDict) || seen.has(node) || depth > MAX_DEPTH) {
      broken = true;
      return;
    }
    seen.add(node);
    const kids = node.lookup(Kids);
    const type = node.lookup(Type);
    if (type !== Page && kids instanceof PDFArray) {
      const next = new Map(inherited);
      for (const key of INHERITED) {
        const value = node.get(key);
        if (value) next.set(key, value);
      }
      for (let i = 0; i < kids.size(); i++) walk(kids.get(i), next, depth + 1);
      return;
    }
    // A page, or a node that draws like one (some writers leave /Type out).
    if (type === Page || node.has(Contents) || node.has(MediaBox)) asLeaf(raw!, node, inherited);
    else broken = true;
  };

  const catalog = context.lookup(context.trailerInfo.Root);
  const root = catalog instanceof PDFDict ? catalog.get(Pages) : undefined;
  const rootNode = root && context.lookup(root);
  const count = rootNode instanceof PDFDict ? rootNode.lookup(Count) : undefined;
  if (count instanceof PDFNumber && Number.isInteger(count.asNumber()) && count.asNumber() <= 100_000) declared = count.asNumber();
  walk(root, new Map(), 0);
  if (leaves.length && declared !== leaves.length) broken = true;

  if (!leaves.length) {
    // No usable tree: every page object there is, with what its parents give it.
    broken = true;
    const orphans = context
      .enumerateIndirectObjects()
      .filter(([, obj]) => obj instanceof PDFDict && obj.lookup(Type) === Page)
      .sort(([a], [b]) => a.objectNumber - b.objectNumber);
    for (const [ref, obj] of orphans) {
      const inherited: Inherited = new Map();
      const up = new Set<PDFObject>();
      for (let node = context.lookup((obj as PDFDict).get(Parent)); node instanceof PDFDict && !up.has(node); node = context.lookup(node.get(Parent))) {
        up.add(node);
        for (const key of INHERITED) {
          const value = node.get(key);
          if (value && !inherited.has(key)) inherited.set(key, value);
        }
      }
      asLeaf(ref, obj as PDFDict, inherited);
    }
  }
  // The declared count only counts when it is at least what was found.
  return { leaves, broken, declared: Math.max(declared, leaves.length) };
}

/**
 * Puts `leaves` under one new page tree, and gives the document a catalog
 * that points at it: a fresh one if its own is missing.
 */
function replaceTree(doc: PDFDocument, leaves: Leaf[]) {
  const { context } = doc;
  const tree = PDFPageTree.withContext(context);
  const treeRef = context.register(tree);
  for (const leaf of leaves) {
    let node = leaf.dict;
    if (!(node instanceof PDFPageLeaf)) {
      node = PDFPageLeaf.fromMapWithContext(new Map(node.entries()), context);
      context.assign(leaf.ref, node);
      leaf.dict = node;
    }
    node.set(Type, Page);
    node.set(Parent, treeRef);
    tree.pushLeafNode(leaf.ref);
  }
  const rootRef = context.trailerInfo.Root;
  const old = context.lookup(rootRef);
  let catalog = old;
  if (!(catalog instanceof PDFCatalog)) {
    catalog = PDFCatalog.fromMapWithContext(new Map(old instanceof PDFDict ? old.entries() : []), context);
    (catalog as PDFCatalog).set(Type, N("Catalog"));
    const ref = rootRef instanceof PDFRef && old instanceof PDFDict ? rootRef : context.nextRef();
    context.assign(ref, catalog);
    context.trailerInfo.Root = ref;
  }
  (catalog as PDFCatalog).set(Pages, treeRef);
  // pdf-lib reads the catalog once, when the file is opened.
  Object.assign(doc, { catalog });
}

const decodable = new Set(["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode", "Fl", "LZW", "A85", "AHx", "RL"]);

/** Whether pdf-lib can check this stream's filters (pictures in JPEG and the like it can't decode). */
function checkable(stream: PDFRawStream): boolean {
  const f = stream.dict.lookup(Filter);
  if (f === undefined) return false;
  const names = f instanceof PDFArray ? f.asArray().map((x) => stream.dict.context.lookup(x)) : [f];
  return names.every((n) => n instanceof PDFName && decodable.has(n.decodeText()));
}

/** True when the stream's data decodes; streams with filters pdf-lib doesn't have pass. */
function decodes(stream: PDFRawStream): boolean {
  if (!checkable(stream)) return true;
  try {
    decodePDFRawStream(stream).decode();
    return true;
  } catch {
    return false;
  }
}

/** What a compressed stream that was cut off or damaged part way holds up to the damage, or null. */
export function inflateUpToDamage(data: Uint8Array): Uint8Array | null {
  for (const Make of [Unzlib, Inflate]) {
    const chunks: Uint8Array[] = [];
    try {
      // Not the final chunk: what decodes is handed over, the rest is waited for.
      new Make((chunk: Uint8Array) => chunks.push(chunk)).push(data, false);
    } catch {
      // Damaged further on: what came before is kept.
    }
    const size = chunks.reduce((n, c) => n + c.length, 0);
    if (!size) continue;
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    // Up to the last line that arrived whole, so no operator is cut in half.
    let end = out.length;
    while (end > 0 && out[end - 1] !== 0x0a && out[end - 1] !== 0x0d) end--;
    const kept = out.subarray(0, end || out.length);
    if (kept.some((b) => b > 0x20)) return kept;
  }
  return null;
}

/**
 * True when everything `root` refers to is there and decodes, checked once
 * per object across pages. A page's parent is not followed.
 */
function sound(doc: PDFDocument, root: PDFObject | undefined, memo: Map<PDFRef, boolean>): boolean {
  const { context } = doc;
  const stack: (PDFObject | undefined)[] = [root];
  const here = new Set<PDFRef>();
  let visited = 0;
  while (stack.length) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      const known = memo.get(obj);
      if (known === false) return false;
      if (known || here.has(obj)) continue;
      here.add(obj);
      const target = context.lookup(obj);
      if (target === undefined || target instanceof PDFInvalidObject || (target instanceof PDFRawStream && !decodes(target))) {
        memo.set(obj, false);
        return false;
      }
      stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) if (key !== Parent && key !== N("P")) stack.push(value);
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    } else if (obj instanceof PDFInvalidObject) {
      return false;
    }
    // A resource tree this big is taken as it is.
    if (++visited > 50_000) break;
  }
  for (const ref of here) memo.set(ref, true);
  return true;
}

interface Health {
  ok: boolean;
  /** Draws something: content or annotations. */
  shows: boolean;
  partial: boolean;
}

/**
 * Whether the page can be copied as it is. Content cut off part way (a
 * download that stopped) keeps what arrived, decoded; content that is
 * missing or can't be read, or resources that are missing or damaged, mean
 * a picture instead.
 */
function checkPage(doc: PDFDocument, leaf: Leaf, memo: Map<PDFRef, boolean>, closed?: string): Health {
  const { context } = doc;
  const node = leaf.dict;
  let shows = false;
  let partial = false;

  // A size readers can use.
  const box = node.lookup(MediaBox);
  const nums = box instanceof PDFArray ? box.asArray().map((v) => context.lookup(v)) : [];
  const valid = nums.length === 4 && nums.every((v) => v instanceof PDFNumber && Number.isFinite(v.asNumber()));
  const [x0, y0, x1, y1] = valid ? nums.map((v) => (v as PDFNumber).asNumber()) : [];
  if (!valid || x0 === x1 || y0 === y1) node.set(MediaBox, context.obj(LETTER));

  // Annotations that are missing go; the rest stay.
  const annots = node.lookup(Annots);
  if (node.has(Annots)) {
    if (!(annots instanceof PDFArray)) node.delete(Annots);
    else {
      for (let i = annots.size() - 1; i >= 0; i--) if (!(context.lookup(annots.get(i)) instanceof PDFDict)) annots.remove(i);
      if (annots.size()) shows = true;
    }
  }

  const raw = node.get(Contents);
  const list = raw === undefined ? [] : (() => {
    const v = context.lookup(raw);
    return v instanceof PDFArray ? v.asArray() : [raw];
  })();
  for (const item of list) {
    const stream = context.lookup(item);
    if (!(stream instanceof PDFRawStream)) return { ok: false, shows, partial };
    if (item instanceof PDFRef && closed === `${item.objectNumber} ${item.generationNumber}`) partial = true;
    if (decodes(stream)) {
      shows ||= stream.contents.some((b) => b > 0x20);
      continue;
    }
    // Damaged part way: what decodes is kept, as plain content.
    const f = stream.dict.lookup(Filter);
    const kept = f === FlateDecode || (f instanceof PDFArray && f.size() === 1 && f.lookup(0) === FlateDecode) ? inflateUpToDamage(stream.contents) : null;
    if (!kept || !(item instanceof PDFRef)) return { ok: false, shows, partial };
    context.assign(item, context.flateStream(kept));
    memo.set(item, true);
    partial = shows = true;
  }
  return { ok: sound(doc, node.get(Resources), memo), shows, partial };
}

/**
 * Takes out references to objects that aren't in the file (lost to a cut or
 * to damage): copied out, a reference to nothing would be given a number
 * that something else then takes. In a list of references (fields, kids,
 * comments) the entry goes; elsewhere it becomes null, so positions hold.
 */
export function pruneDangling(doc: PDFDocument) {
  const { context } = doc;
  const missing = (v: PDFObject | undefined) => v instanceof PDFRef && context.lookup(v) === undefined;
  const seen = new Set<PDFObject>();
  const visit = (obj: PDFObject | undefined) => {
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        if (missing(value)) obj.delete(key);
        else if (!(value instanceof PDFRef)) visit(value);
      }
    } else if (obj instanceof PDFArray) {
      const items = obj.asArray();
      const refs = items.every((v) => v instanceof PDFRef);
      for (let i = items.length - 1; i >= 0; i--) {
        if (!missing(items[i])) {
          if (!(items[i] instanceof PDFRef)) visit(items[i]);
        } else if (refs) obj.remove(i);
        else obj.set(i, PDFNull);
      }
    } else if (obj instanceof PDFStream) {
      visit(obj.dict);
    }
  };
  for (const [, obj] of context.enumerateIndirectObjects()) visit(obj);
  // The trailer's own entries too: a lost /Info is dropped.
  const trailer = context.trailerInfo;
  if (missing(trailer.Info)) trailer.Info = undefined;
}

/** How many fields the document's form has (the ones that hold a value). */
export function countFields(doc: PDFDocument): number {
  const { context } = doc;
  const catalog = context.lookup(context.trailerInfo.Root);
  const form = catalog instanceof PDFDict ? catalog.lookup(N("AcroForm")) : undefined;
  const top = form instanceof PDFDict ? form.lookup(N("Fields")) : undefined;
  const seen = new Set<PDFDict>();
  let count = 0;
  const walk = (list: PDFObject | undefined, depth: number) => {
    const arr = context.lookup(list);
    if (!(arr instanceof PDFArray) || depth > MAX_DEPTH) return;
    for (let i = 0; i < arr.size(); i++) {
      const node = context.lookup(arr.get(i));
      if (!(node instanceof PDFDict) || seen.has(node)) continue;
      seen.add(node);
      const kids = node.lookup(Kids);
      // A field's widgets are its kids too: it counts once, as the field.
      const fieldKids = kids instanceof PDFArray && kids.asArray().some((k) => {
        const kid = context.lookup(k);
        return kid instanceof PDFDict && kid.has(N("T"));
      });
      if (fieldKids) walk(kids, depth + 1);
      else count++;
    }
  };
  walk(top, 0);
  return count;
}

/** How many bookmarks the document has. */
export function countBookmarks(doc: PDFDocument): number {
  const { context } = doc;
  const catalog = context.lookup(context.trailerInfo.Root);
  const outlines = catalog instanceof PDFDict ? catalog.lookup(N("Outlines")) : undefined;
  const seen = new Set<PDFDict>();
  const pending: PDFObject[] = [];
  if (outlines instanceof PDFDict) {
    const first = outlines.get(N("First"));
    if (first) pending.push(first);
  }
  while (pending.length && seen.size < 100_000) {
    const item = context.lookup(pending.pop());
    if (!(item instanceof PDFDict) || seen.has(item)) continue;
    seen.add(item);
    for (const key of ["Next", "First"]) {
      const v = item.get(N(key));
      if (v) pending.push(v);
    }
  }
  return seen.size;
}

/** No page of the file could be read: there is nothing to give back. */
export class NothingRecoveredError extends Error {
  constructor(message = "Nothing in this file could be recovered: its pages can't be read or are blank.") {
    super(message);
  }
}

const extras = (doc: PDFDocument): Extras => ({ fields: countFields(doc), bookmarks: countBookmarks(doc) });

/** pdf-lib, reading every object it can and decrypting nothing. */
const load = (bytes: Uint8Array) =>
  PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });

/**
 * A copy of the pages `order` names, keeping what goes with them. A part of
 * the catalog that won't copy (a tag tree that loops, a broken form) is left
 * behind rather than losing the pages.
 */
async function copyOut(doc: PDFDocument, order: number[]): Promise<Uint8Array> {
  const catalog = doc.catalog;
  const steps = [["StructTreeRoot", "MarkInfo"], ["AcroForm", "Outlines", "Names", "Dests", "OCProperties", "PageLabels"]];
  for (let step = 0; ; step++) {
    try {
      return await extractFrom(doc, order);
    } catch (err) {
      if (step === steps.length) throw err;
      for (const key of steps[step]) catalog.delete(N(key));
    }
  }
}

/** What pdf-lib makes of `bytes`, or null. Logs from its parser are kept out of the console. */
async function quietLoad(bytes: Uint8Array): Promise<PDFDocument | null> {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await load(bytes);
  } catch {
    return null;
  } finally {
    console.warn = warn;
  }
}

/**
 * Salvages and reads `input`, and copies out every page that can be copied
 * as it is. See Rebuilt for what comes back.
 */
export async function rebuildPdf(input: Uint8Array, opts: { onProgress?: Progress; signal?: AbortSignal } = {}): Promise<Rebuilt> {
  const progress = opts.onProgress ?? (() => {});
  progress(0, "Reading the file…");
  const salvaged = salvage(input);
  const fixes: Fix[] = [...salvaged.fixes];
  stopIfAborted(opts.signal);
  const unpacked = unpackObjectStreams(salvaged.bytes);
  if (unpacked.repaired) fixes.push("objects");
  stopIfAborted(opts.signal);

  let doc = await quietLoad(unpacked.bytes);
  stopIfAborted(opts.signal);
  const unread = (encrypted = false): Rebuilt => ({ kind: "unread", bytes: unpacked.bytes, fixes, encrypted });
  if (!doc) return unread();

  if (doc.isEncrypted) {
    // Restricted by an owner password only: it opens without one, decrypted.
    // One that needs a password, or that won't decrypt, goes to pdf.js, which
    // says which it is.
    try {
      const { unlockPdf } = await import("../security");
      doc = await quietLoad(await unlockPdf(unpacked.bytes, ""));
    } catch {
      doc = null;
    }
    if (!doc || doc.isEncrypted) return unread(true);
  }

  const { leaves, broken, declared } = collectPages(doc);
  if (!leaves.length) return unread();
  if (broken) fixes.push("pages");
  replaceTree(doc, leaves);
  pruneDangling(doc);
  // Fields whose pages were lost go with them.
  if (fixes.includes("pages") || fixes.includes("cut-off")) dropFieldsOffPages(doc);
  const before = extras(doc);

  const memo = new Map<PDFRef, boolean>();
  const health = leaves.map((leaf, i) => {
    if (i % 25 === 0) {
      stopIfAborted(opts.signal);
      progress((i / leaves.length) * 0.5, `Checking page ${i + 1} of ${leaves.length}`);
    }
    return checkPage(doc!, leaf, memo, salvaged.closed);
  });
  const slots: Slot[] = health.map((h) => (h.ok ? { kind: "vector", shows: h.shows, ...(h.partial ? { partial: true } : {}) } : { kind: "picture" }));
  const bad = slots.flatMap((s, i) => (s.kind === "picture" ? [i] : []));
  // Pages that draw nothing at all count only when others do: a file of empty pages is not recovered.
  if (!bad.length && !health.some((h) => h.shows)) return unread();

  stopIfAborted(opts.signal);
  progress(0.5, "Rebuilding the file…");
  const all = leaves.map((_, i) => i);
  let render: Uint8Array | null = null;
  let renderPages: number[] = [];
  if (bad.length) {
    // The damaged pages alone, as they are, for pdf.js to draw; or, when
    // they won't copy out, the whole document.
    try {
      render = await copyOut(doc, bad);
      renderPages = bad.map((_, k) => k + 1);
    } catch {
      render = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
      renderPages = bad.map((i) => i + 1);
    }
    // Their places in the copy are kept empty for the pictures, so bookmarks
    // and links to them still lead there. Their own fields and comments go:
    // the picture shows them.
    for (const i of bad) {
      const node = leaves[i].dict;
      for (const key of [Contents, Resources, Annots]) node.delete(key);
    }
  }
  stopIfAborted(opts.signal);
  let vector: Uint8Array;
  try {
    vector = await copyOut(doc, all);
  } catch {
    // Not even the pages alone copy out: pdf.js draws them all.
    return unread();
  }
  progress(0.95, "Rebuilding the file…");
  if (render) return { kind: "pictures", vector, render, renderPages, slots, declared, fixes, before };
  const out = await load(vector);
  return { kind: "done", bytes: vector, slots, declared, fixes, before, after: extras(out) };
}

/**
 * Puts the pictures (the pages of `pictures`, one for each place listed in
 * `placed`) into the places `rebuildPdf` kept for them in `vector`. Places
 * left without a picture (pdf.js couldn't draw that page either) are
 * removed, with the links and bookmarks that lead there.
 */
export async function splicePictures(
  vector: Uint8Array,
  pictures: Uint8Array | null,
  placed: number[],
  empty: number[]
): Promise<{ bytes: Uint8Array; after: Extras; pages: number }> {
  const doc = await PDFDocument.load(vector, { updateMetadata: false });
  if (pictures && placed.length) {
    const pics = await PDFDocument.load(pictures, { updateMetadata: false });
    const copied = await doc.copyPages(pics, placed.map((_, k) => k));
    placed.forEach((index, k) => {
      const target = doc.getPage(index).node;
      const from = copied[k].node;
      // The picture is the page as it was shown: upright, cut to its crop box.
      for (const key of ["CropBox", "TrimBox", "BleedBox", "ArtBox", "Rotate", "UserUnit", "Group"]) target.delete(N(key));
      for (const key of [MediaBox, Contents, Resources]) {
        const value = from.get(key);
        if (value) target.set(key, value);
      }
    });
  }
  const gone = new Set(empty);
  const kept = doc.getPageIndices().filter((i) => !gone.has(i));
  if (!kept.length) throw new NothingRecoveredError();
  if (gone.size) arrangePages(doc, kept);
  // The fields of the pages that are pictures now are part of the picture.
  dropFieldsOffPages(doc);
  dropUnreachable(doc);
  const bytes = await doc.save({ updateFieldAppearances: false, addDefaultPage: false });
  return { bytes, after: extras(doc), pages: doc.getPageCount() };
}
