/**
 * Lossless PowerPoint (.pptx) package operations over JSZip.
 *
 * The original OOXML package is edited in place: parts that an operation does
 * not touch are written back byte-for-byte (same uncompressed content), and
 * XML parts that are touched are re-serialized from a lossless tree
 * (lib/pptx/xml-dom.ts), so everything we don't understand survives. Works in the
 * browser and in Node (no DOMParser needed).
 *
 * Mapping to pptxtojson (verified in tests/pptx-ops.test.mts by parsing the
 * fixtures with pptxtojson 2.2.0 in Node): every element pptxtojson returns
 * for a slide has `id` equal to the `id` attribute of the shape's
 * `p:cNvPr` (p:nvSpPr / p:nvPicPr / p:nvGrpSpPr / p:nvGraphicFramePr, also
 * inside mc:AlternateContent), as a string. Group elements carry the group's
 * cNvPr id and their `elements` carry the children's ids. So a rendered
 * element maps directly to `TextShape.shapeId` from getSlideTexts(), and
 * setShapeText(deck, i, element.id, ...) edits it. Table cells are addressed
 * as `${frameId}:${row}:${col}` (the table element's id is the frame's
 * cNvPr id). pptxtojson works in Node without DOMParser (it only uses it,
 * when present, to test whether HTML text is empty); in Node import it as
 * "pptxtojson/dist/index.js" (the bare specifier resolves to a UMD file).
 *
 * pptxtojson caveats that matter for the editor:
 *  - It orders slides by the number in the part name (slide1.xml,
 *    slide2.xml...) taken from [Content_Types].xml, NOT by p:sldIdLst. So
 *    saveDeck() renumbers slide parts to presentation order by default;
 *    otherwise a moved/duplicated slide would render at the wrong index.
 *  - It hard-codes the "p:"/"a:" prefixes and skips shapes wrapped in
 *    mc:AlternateContent at the top level of the shape tree, so such shapes
 *    are editable here but not rendered by pptxtojson.
 *
 * Text semantics (getSlideTexts / setShapeText):
 *  - One string per a:p. a:br is represented as "\n" inside the paragraph
 *    string; a:fld contributes its current cached text.
 *  - setShapeText leaves a paragraph completely untouched when its text is
 *    unchanged (so fields, line breaks and per-run formatting survive).
 *    Paragraphs are matched to the old ones as a diff (inserting or deleting
 *    a line leaves the others alone). An edited paragraph keeps its a:pPr,
 *    a:endParaRPr and the runs around the change; the changed text takes the
 *    a:rPr of the run where the change starts; "\n" becomes a:br. A new
 *    paragraph copies the pPr/rPr/endParaRPr of the one before it (minus
 *    any hyperlink).
 */
import JSZip from "jszip";
import {
  type XmlDocument,
  type XmlElement,
  appendChild,
  child,
  children,
  cloneElement,
  createElement,
  descendants,
  elementChildren,
  getAttr,
  insertAfter,
  isEl,
  localName,
  parseXml,
  removeNode,
  removeNodeTidy,
  serializeXml,
  setAttr,
  setAttrNS,
  setTextContent,
  stripInvalidXmlChars,
  textContent,
} from "./xml-dom";

/* ------------------------------------------------------------------ */
/* Namespaces and relationship types                                   */
/* ------------------------------------------------------------------ */

export const NS = {
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  pr: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
  p14: "http://schemas.microsoft.com/office/powerpoint/2010/main",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  ep: "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
} as const;

const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
const REL = {
  officeDocument: RT + "officeDocument",
  officeDocumentStrict: "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
  extendedProperties: RT + "extended-properties",
  slide: RT + "slide",
  slideLayout: RT + "slideLayout",
  notesSlide: RT + "notesSlide",
} as const;

/**
 * Relationship types whose target belongs to exactly one source part. When a
 * slide is duplicated these are deep-copied (a notes slide, chart or comment
 * part must not be shared by two slides); everything else (layouts, media,
 * tags, hyperlinks...) is shared by reference.
 */
const OWNED_REL_TYPES = new Set([
  RT + "notesSlide",
  RT + "chart",
  RT + "comments",
  RT + "diagramData",
  RT + "diagramDrawing",
  "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
  "http://schemas.microsoft.com/office/2014/relationships/chartEx",
  "http://schemas.microsoft.com/office/2018/10/relationships/comments",
  // Children of a deep-copied chart:
  RT + "package",
  RT + "chartUserShapes",
  "http://schemas.microsoft.com/office/2011/relationships/chartStyle",
  "http://schemas.microsoft.com/office/2011/relationships/chartColorStyle",
]);

const SECTION_EXT_URI = "{521415D9-36F7-43E2-AB2F-B90AF26B5E84}";
const CONTENT_TYPES = "[Content_Types].xml";
const ROOT_RELS = "_rels/.rels";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface SlideInfo {
  /** 0-based position in presentation order. */
  index: number;
  /** Part path inside the zip, e.g. "ppt/slides/slide3.xml". */
  part: string;
  /** Relationship id in the presentation part's rels. */
  rId: string;
  /** p:sldId/@id */
  sldId: number;
  /** Notes slide part path, or null. */
  notesPart: string | null;
  /** Slide layout part path, or null. */
  layoutPart: string | null;
  /** p:sld/@show="0" */
  hidden: boolean;
}

export interface SlideSize {
  /** EMU */
  cx: number;
  cy: number;
  widthPt: number;
  heightPt: number;
}

export interface TextShape {
  /**
   * Address for setShapeText: the shape's p:cNvPr id for shapes, or
   * `${frameId}:${row}:${col}` for table cells.
   */
  id: string;
  /** p:cNvPr id of the shape (or of the table's graphic frame). */
  shapeId: string;
  /** p:cNvPr name */
  name: string;
  kind: "shape" | "tableCell";
  /** Present for table cells. */
  row?: number;
  col?: number;
  /** Merged table cells: how many columns / rows the cell covers (a:tc gridSpan / rowSpan). */
  colSpan?: number;
  rowSpan?: number;
  /** Placeholder type (p:ph/@type, "body" when p:ph has no type), else null. */
  placeholder: string | null;
  /** One entry per a:p; a:br is "\n". */
  paragraphs: string[];
}

export class PptxError extends Error {}

type PartSource = { zipName: string } | { created: true };

export class Deck {
  /** @internal */ zip: JSZip;
  /** @internal Current parts, in package order. */ parts = new Map<string, PartSource>();
  /** @internal lower-case name -> actual name */ lower = new Map<string, string>();
  /** @internal Raw text of XML-ish parts, loaded at open. */ texts = new Map<string, string>();
  /** @internal */ docs = new Map<string, XmlDocument>();
  /** @internal */ dirty = new Set<string>();
  /** @internal */ presPath = "";

  /** @internal */
  constructor(zip: JSZip) {
    this.zip = zip;
  }

  get slideCount(): number {
    return slideIdElements(this).length;
  }

  get slideSize(): SlideSize {
    const sz = child(presRoot(this), NS.p, "sldSz");
    const cx = Number(sz && getAttr(sz, "cx")) || 9144000;
    const cy = Number(sz && getAttr(sz, "cy")) || 6858000;
    return { cx, cy, widthPt: cx / 12700, heightPt: cy / 12700 };
  }

  get slides(): SlideInfo[] {
    return listSlides(this);
  }

  /** @internal True for XML parts (loaded at open or created by an operation). */
  isXml(name: string): boolean {
    const actual = this.resolveName(name);
    return !!actual && (this.docs.has(actual) || this.texts.has(actual));
  }

  /** @internal */
  has(name: string): boolean {
    return this.resolveName(name) !== null;
  }

  /** @internal Actual part name for a (case-insensitive) name, or null. */
  resolveName(name: string): string | null {
    if (this.parts.has(name)) return name;
    return this.lower.get(name.toLowerCase()) ?? null;
  }

  /** @internal */
  doc(name: string): XmlDocument {
    const actual = this.resolveName(name);
    if (!actual) throw new PptxError(`Missing part ${name}`);
    let d = this.docs.get(actual);
    if (!d) {
      const t = this.texts.get(actual);
      if (t === undefined) throw new PptxError(`Part ${actual} is not XML`);
      d = parseXml(t);
      this.docs.set(actual, d);
    }
    return d;
  }

  /** @internal Returns the doc and marks it modified. */
  edit(name: string): XmlDocument {
    const d = this.doc(name);
    this.dirty.add(this.resolveName(name)!);
    return d;
  }

  /** @internal */
  addPart(name: string, source: PartSource, doc?: XmlDocument): void {
    this.parts.set(name, source);
    this.lower.set(name.toLowerCase(), name);
    if (doc) {
      this.docs.set(name, doc);
      this.dirty.add(name);
    }
  }

  /** @internal */
  removePart(name: string): void {
    const actual = this.resolveName(name);
    if (!actual) return;
    this.parts.delete(actual);
    this.lower.delete(actual.toLowerCase());
    this.docs.delete(actual);
    this.dirty.delete(actual);
    this.texts.delete(actual);
  }
}

/* ------------------------------------------------------------------ */
/* Paths and relationships                                             */
/* ------------------------------------------------------------------ */

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Resolves a relationship target relative to the source part. */
export function resolveTarget(sourcePart: string, target: string): string {
  const t = safeDecode(target.split("#")[0]);
  if (t.startsWith("/")) return normalizePath(t);
  return normalizePath((dirname(sourcePart) ? dirname(sourcePart) + "/" : "") + t);
}

/** Relative target from `fromPart` to `toPart`. */
export function relativeTarget(fromPart: string, toPart: string): string {
  const from = dirname(fromPart).split("/").filter(Boolean);
  const to = toPart.split("/");
  let k = 0;
  while (k < from.length && k < to.length - 1 && from[k] === to[k]) k++;
  const ups = from.slice(k).map(() => "..");
  return [...ups, ...to.slice(k)].join("/");
}

export function relsPathOf(part: string): string {
  if (part === "") return ROOT_RELS;
  const d = dirname(part);
  return (d ? d + "/" : "") + "_rels/" + basename(part) + ".rels";
}

interface Rel {
  el: XmlElement;
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** Resolved part name for internal targets. */
  resolved: string | null;
}

function readRels(deck: Deck, part: string): Rel[] {
  const rp = relsPathOf(part);
  if (!deck.has(rp)) return [];
  const root = deck.doc(rp).root;
  return children(root, NS.pr, "Relationship").map((el) => {
    const target = getAttr(el, "Target") ?? "";
    const external = (getAttr(el, "TargetMode") ?? "") === "External";
    let resolved: string | null = null;
    if (!external) {
      const r = part === "" ? normalizePath(safeDecode(target)) : resolveTarget(part, target);
      resolved = deck.resolveName(r) ?? r;
    }
    return { el, id: getAttr(el, "Id") ?? "", type: getAttr(el, "Type") ?? "", target, external, resolved };
  });
}

function nextRelId(rels: Rel[]): string {
  let max = 0;
  const used = new Set(rels.map((r) => r.id));
  for (const r of rels) {
    const m = /^rId(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (used.has("rId" + n)) n++;
  return "rId" + n;
}

function addRel(deck: Deck, sourcePart: string, type: string, targetPart: string): string {
  const rp = relsPathOf(sourcePart);
  const id = nextRelId(readRels(deck, sourcePart));
  const root = deck.edit(rp).root;
  const el = createElement(root, NS.pr, "Relationship");
  setAttr(el, "Id", id);
  setAttr(el, "Type", type);
  setAttr(el, "Target", relativeTarget(sourcePart, targetPart));
  appendChild(root, el);
  return id;
}

/* ------------------------------------------------------------------ */
/* Content types                                                       */
/* ------------------------------------------------------------------ */

function overrideFor(deck: Deck, part: string): XmlElement | null {
  const root = deck.doc(CONTENT_TYPES).root;
  const want = "/" + part.toLowerCase();
  for (const o of children(root, NS.ct, "Override")) {
    if ((getAttr(o, "PartName") ?? "").toLowerCase() === want) return o;
  }
  return null;
}

function contentTypeOf(deck: Deck, part: string): string | null {
  const o = overrideFor(deck, part);
  if (o) return getAttr(o, "ContentType");
  const ext = part.slice(part.lastIndexOf(".") + 1).toLowerCase();
  for (const d of children(deck.doc(CONTENT_TYPES).root, NS.ct, "Default")) {
    if ((getAttr(d, "Extension") ?? "").toLowerCase() === ext) return getAttr(d, "ContentType");
  }
  return null;
}

function addOverride(deck: Deck, part: string, contentType: string): void {
  if (overrideFor(deck, part)) return;
  const root = deck.edit(CONTENT_TYPES).root;
  const el = createElement(root, NS.ct, "Override");
  setAttr(el, "PartName", "/" + part);
  setAttr(el, "ContentType", contentType);
  appendChild(root, el);
}

function removeOverride(deck: Deck, part: string): void {
  const o = overrideFor(deck, part);
  if (o) {
    deck.edit(CONTENT_TYPES);
    removeNodeTidy(o);
  }
}

/* ------------------------------------------------------------------ */
/* Open / save                                                         */
/* ------------------------------------------------------------------ */

function looksLikeXml(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".xml") || n.endsWith(".rels") || n.endsWith(".vml");
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

export async function openDeck(bytes: ArrayBuffer | Uint8Array): Promise<Deck> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new PptxError("Not a valid .pptx file");
  }
  try {
    return await readDeck(zip);
  } catch (e) {
    if (e instanceof PptxError) throw e;
    throw new PptxError(`Damaged .pptx file: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function readDeck(zip: JSZip): Promise<Deck> {
  const deck = new Deck(zip);
  const names: string[] = [];
  zip.forEach((path, file) => {
    if (!file.dir) names.push(path);
  });
  for (const name of names) {
    deck.addPart(name, { zipName: name });
    if (looksLikeXml(name)) {
      deck.texts.set(name, decodeText(await zip.file(name)!.async("uint8array")));
    }
  }
  if (!deck.has(CONTENT_TYPES) || !deck.has(ROOT_RELS)) throw new PptxError("Not a valid .pptx file");
  const main = readRels(deck, "").find((r) => r.type === REL.officeDocument || r.type === REL.officeDocumentStrict);
  if (!main || !main.resolved || !deck.has(main.resolved)) throw new PptxError("Not a PowerPoint file");
  deck.presPath = deck.resolveName(main.resolved)!;
  const root = deck.doc(deck.presPath).root;
  if (!(root.ns === NS.p && localName(root.name) === "presentation")) throw new PptxError("Not a PowerPoint file");
  // Validate slide references up front so later operations can rely on them.
  listSlides(deck);
  return deck;
}

export interface SaveOptions {
  /**
   * Rename slide parts so slideN.xml matches presentation order (default
   * true). PowerPoint doesn't need this, but pptxtojson (and some other
   * readers) order slides by part number instead of p:sldIdLst, so without
   * it a reordered deck would render in the old order. Mutates `deck`.
   */
  renumber?: boolean;
}

/** Media that is already compressed. */
const PRECOMPRESSED = /\.(jpe?g|png|gif|webp|mp4|m4v|mov|wmv|avi|mpe?g|webm|ogv|mp3|m4a|wma|ogg|oga|aac)$/i;

export async function saveDeck(deck: Deck, options: SaveOptions = {}): Promise<Uint8Array> {
  if (options.renumber !== false) renumberSlideParts(deck);
  const out = new JSZip();
  const order = [...deck.parts.keys()];
  const ct = order.indexOf(CONTENT_TYPES);
  if (ct > 0) {
    order.splice(ct, 1);
    order.unshift(CONTENT_TYPES);
  }
  const enc = new TextEncoder();
  for (const name of order) {
    const src = deck.parts.get(name)!;
    let data: Uint8Array;
    if (deck.dirty.has(name)) {
      const d = deck.docs.get(name)!;
      // Dirty parts are always written as UTF-8.
      const prolog = d.prolog.replace(/(<\?xml[^?]*encoding=)(["'])UTF-16(LE|BE)?\2/i, "$1$2UTF-8$2");
      data = enc.encode(serializeXml({ ...d, prolog }));
    } else if ("zipName" in src) {
      data = await deck.zip.file(src.zipName)!.async("uint8array");
    } else {
      throw new PptxError(`No content for ${name}`);
    }
    // Deflating JPEGs, PNGs and video gains nothing and is most of the save
    // time on photo-heavy decks: store them as they are.
    out.file(name, data, { compression: PRECOMPRESSED.test(name) ? "STORE" : "DEFLATE", createFolders: false });
  }
  return out.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/**
 * Renames slide parts to ppt/slides/slide1.xml ... slideN.xml in
 * presentation order (like PowerPoint does on save), updating their rels
 * parts, every relationship that targets them and the content-type
 * overrides. Slide contents are not modified. Returns true if anything was
 * renamed. Skipped when slides live in different folders.
 */
export function renumberSlideParts(deck: Deck): boolean {
  const slides = listSlides(deck);
  if (!slides.length) return false;
  const dir = dirname(slides[0].part);
  if (slides.some((s) => dirname(s.part) !== dir)) return false;
  const rename = new Map<string, string>();
  slides.forEach((s, k) => {
    const want = (dir ? dir + "/" : "") + `slide${k + 1}.xml`;
    if (s.part !== want) rename.set(s.part, want);
  });
  if (!rename.size) return false;
  const finalNames = new Set(slides.map((s) => rename.get(s.part) ?? s.part));
  // A non-slide part already using a wanted name would collide.
  for (const n of finalNames) {
    const actual = deck.resolveName(n);
    if (actual && !slides.some((s) => s.part === actual)) return false;
  }
  for (const [from, to] of [...rename]) {
    const rf = relsPathOf(from);
    if (deck.has(rf)) rename.set(rf, relsPathOf(to));
  }
  const newName = (n: string) => rename.get(n) ?? n;

  // 1. Retarget relationships (resolved with the old names).
  for (const name of [...deck.parts.keys()]) {
    if (!name.endsWith(".rels")) continue;
    const source = relsSource(name);
    if (source === null) continue;
    const rels = readRels(deck, source);
    const touched = rels.filter((r) => !r.external && r.resolved && (rename.has(r.resolved) || rename.has(source)));
    const changes = touched
      .map((r) => ({ r, target: source === "" ? newName(r.resolved!) : relativeTarget(newName(source), newName(r.resolved!)) }))
      .filter(({ r, target }) => target !== r.target);
    if (!changes.length) continue;
    deck.edit(name);
    for (const { r, target } of changes) setAttr(r.el, "Target", target);
  }
  // 2. Content types.
  const overrides = [...rename].map(([from, to]) => [overrideFor(deck, from), to] as const);
  for (const [o, to] of overrides) {
    if (!o) continue;
    deck.edit(CONTENT_TYPES);
    setAttr(o, "PartName", "/" + to);
  }
  // 3. Rename the parts, keeping package order.
  const entries = [...deck.parts.entries()];
  deck.parts.clear();
  deck.lower.clear();
  const moveKey = <T,>(m: Map<string, T>) => {
    const moved: [string, T][] = [];
    for (const [k, v] of m) if (rename.has(k)) moved.push([k, v]);
    for (const [k] of moved) m.delete(k);
    for (const [k, v] of moved) m.set(rename.get(k)!, v);
  };
  for (const [name, src] of entries) {
    const n = newName(name);
    deck.parts.set(n, src);
    deck.lower.set(n.toLowerCase(), n);
  }
  moveKey(deck.docs);
  moveKey(deck.texts);
  const dirty = [...deck.dirty].map(newName);
  deck.dirty.clear();
  dirty.forEach((d) => deck.dirty.add(d));
  return true;
}

/* ------------------------------------------------------------------ */
/* Presentation structure                                              */
/* ------------------------------------------------------------------ */

function presRoot(deck: Deck): XmlElement {
  return deck.doc(deck.presPath).root;
}

function sldIdLst(deck: Deck): XmlElement | null {
  return child(presRoot(deck), NS.p, "sldIdLst");
}

function slideIdElements(deck: Deck): XmlElement[] {
  const lst = sldIdLst(deck);
  return lst ? children(lst, NS.p, "sldId") : [];
}

export function listSlides(deck: Deck): SlideInfo[] {
  const rels = new Map(readRels(deck, deck.presPath).map((r) => [r.id, r]));
  return slideIdElements(deck).map((el, index) => {
    const rId = getAttr(el, "id", NS.r) ?? "";
    const rel = rels.get(rId);
    if (!rel || rel.external || !rel.resolved || !deck.has(rel.resolved)) {
      throw new PptxError(`Slide ${index + 1} is missing from the package`);
    }
    const part = rel.resolved;
    const srels = readRels(deck, part);
    const notes = srels.find((r) => r.type === REL.notesSlide && !r.external && r.resolved && deck.has(r.resolved));
    const layout = srels.find((r) => r.type === REL.slideLayout && !r.external);
    const sld = deck.doc(part).root;
    return {
      index,
      part,
      rId,
      sldId: Number(getAttr(el, "id")),
      notesPart: notes?.resolved ?? null,
      layoutPart: layout?.resolved ?? null,
      hidden: getAttr(sld, "show") === "0",
    };
  });
}

function checkIndex(deck: Deck, index: number, what = "Slide index"): void {
  if (!Number.isInteger(index) || index < 0 || index >= deck.slideCount) {
    throw new PptxError(`${what} ${index} out of range (0..${deck.slideCount - 1})`);
  }
}

/** Replaces `els` (all children of the same parent) with `ordered`, keeping the slots they occupied. */
function reorderInPlace(els: XmlElement[], ordered: XmlElement[]): void {
  if (!els.length) return;
  const parent = els[0].parent!;
  const slots = els.map((e) => parent.children.indexOf(e));
  slots.forEach((slot, k) => {
    parent.children[slot] = ordered[k];
    ordered[k].parent = parent;
  });
}

/* --------------------------- sections ------------------------------ */

interface Section {
  el: XmlElement;
  list: XmlElement | null;
  ids: string[];
}

function sectionLst(deck: Deck): XmlElement | null {
  const ext = child(presRoot(deck), NS.p, "extLst");
  if (!ext) return null;
  for (const e of children(ext, NS.p, "ext")) {
    if ((getAttr(e, "uri") ?? "").toUpperCase() !== SECTION_EXT_URI) continue;
    const lst = child(e, NS.p14, "sectionLst");
    if (lst) return lst;
  }
  return null;
}

function readSections(deck: Deck): Section[] | null {
  const lst = sectionLst(deck);
  if (!lst) return null;
  return children(lst, NS.p14, "section").map((el) => {
    const list = child(el, NS.p14, "sldIdLst");
    const ids = list ? children(list, NS.p14, "sldId").map((s) => getAttr(s, "id") ?? "") : [];
    return { el, list, ids };
  });
}

function writeSectionIds(sec: Section, ids: string[]): void {
  if (sec.ids.length === ids.length && sec.ids.every((v, k) => v === ids[k])) return;
  let list = sec.list;
  if (!list) {
    list = createElement(sec.el, NS.p14, "sldIdLst");
    sec.el.children.unshift(list);
    list.parent = sec.el;
    sec.list = list;
  }
  const existing = new Map(children(list, NS.p14, "sldId").map((e) => [getAttr(e, "id") ?? "", e]));
  const kids = ids.map((id) => {
    const reuse = existing.get(id);
    if (reuse) {
      existing.delete(id);
      return reuse;
    }
    const e = createElement(list!, NS.p14, "sldId");
    setAttr(e, "id", id);
    return e;
  });
  for (const c of list.children) if (c.type === "element") c.parent = null;
  list.children = [];
  for (const k of kids) appendChild(list, k);
  sec.ids = ids;
}

/**
 * Applies a slide order (as sldIds) to the sections, given which section
 * each slide should belong to. If that membership leaves every section
 * contiguous, sections follow it (and are themselves reordered when whole
 * sections moved); otherwise sections keep their sizes and slides flow into
 * them by position.
 */
function applySections(deck: Deck, order: string[], membership: Map<string, number>): void {
  const secs = readSections(deck);
  if (!secs || !secs.length) return;
  deck.edit(deck.presPath);
  // Assign orphans (not in any section) to the section of the previous slide.
  let last = 0;
  const mem = order.map((id) => {
    const m = membership.get(id);
    if (m !== undefined) last = m;
    return m ?? last;
  });
  const runs: number[] = [];
  for (const m of mem) if (runs[runs.length - 1] !== m) runs.push(m);
  const contiguous = new Set(runs).size === runs.length;
  if (contiguous) {
    const nonEmpty = new Set(runs);
    // Empty sections stay attached after the section that preceded them.
    const leading: number[] = [];
    const trailing = new Map<number, number[]>();
    let prev = -1;
    secs.forEach((_, k) => {
      if (nonEmpty.has(k)) prev = k;
      else if (prev < 0) leading.push(k);
      else trailing.set(prev, [...(trailing.get(prev) ?? []), k]);
    });
    const secOrder = [...leading];
    for (const r of runs) secOrder.push(r, ...(trailing.get(r) ?? []));
    secs.forEach((s, k) => writeSectionIds(s, order.filter((_, j) => mem[j] === k)));
    if (secOrder.some((v, k) => v !== k)) {
      reorderInPlace(secs.map((s) => s.el), secOrder.map((k) => secs[k].el));
    }
    return;
  }
  // Positional fallback: section sizes are preserved.
  let pos = 0;
  secs.forEach((s, k) => {
    const size = k === secs.length - 1 ? order.length - pos : Math.min(s.ids.length, order.length - pos);
    writeSectionIds(s, order.slice(pos, pos + size));
    pos += size;
  });
}

function currentMembership(deck: Deck): Map<string, number> {
  const m = new Map<string, number>();
  (readSections(deck) ?? []).forEach((s, k) => s.ids.forEach((id) => m.set(id, k)));
  return m;
}

/* ------------------------------------------------------------------ */
/* Reordering                                                          */
/* ------------------------------------------------------------------ */

function applyOrder(deck: Deck, newOrder: number[], membership: Map<string, number>): void {
  const els = slideIdElements(deck);
  const ordered = newOrder.map((k) => els[k]);
  const ids = ordered.map((e) => getAttr(e, "id") ?? "");
  if (newOrder.some((v, k) => v !== k)) {
    deck.edit(deck.presPath);
    reorderInPlace(els, ordered);
  }
  applySections(deck, ids, membership);
}

export function reorderSlides(deck: Deck, newOrder: number[]): void {
  const n = deck.slideCount;
  const seen = new Set(newOrder);
  if (newOrder.length !== n || seen.size !== n || newOrder.some((v) => !Number.isInteger(v) || v < 0 || v >= n)) {
    throw new PptxError("newOrder must be a permutation of the slide indexes");
  }
  if (newOrder.every((v, k) => v === k)) return;
  applyOrder(deck, newOrder, currentMembership(deck));
}

export function moveSlide(deck: Deck, from: number, to: number): void {
  checkIndex(deck, from, "from");
  checkIndex(deck, to, "to");
  if (from === to) return;
  const order = [...Array(deck.slideCount).keys()];
  order.splice(from, 1);
  order.splice(to, 0, from);
  const membership = currentMembership(deck);
  if (membership.size) {
    // The moved slide joins the section of its new neighbour (the slide
    // before it, or the one after it when it becomes the first slide).
    const els = slideIdElements(deck);
    const idOf = (k: number) => getAttr(els[k], "id") ?? "";
    const neighbour = to > 0 ? order[to - 1] : order[1];
    const sec = membership.get(idOf(neighbour));
    if (sec !== undefined) membership.set(idOf(from), sec);
  }
  applyOrder(deck, order, membership);
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

function reachableParts(deck: Deck): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [""];
  while (queue.length) {
    const part = queue.shift()!;
    for (const r of readRels(deck, part)) {
      if (r.external || !r.resolved) continue;
      const actual = deck.resolveName(r.resolved);
      if (!actual || seen.has(actual)) continue;
      seen.add(actual);
      queue.push(actual);
    }
  }
  return seen;
}

function closureFrom(deck: Deck, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length) {
    const part = queue.shift()!;
    for (const r of readRels(deck, part)) {
      if (r.external || !r.resolved) continue;
      const actual = deck.resolveName(r.resolved);
      if (!actual || seen.has(actual)) continue;
      seen.add(actual);
      queue.push(actual);
    }
  }
  return seen;
}

const HLINK_LOCALS = new Set(["hlinkClick", "hlinkHover", "hlinkMouseOver"]);

/** Removes every relationship (in any rels part) that targets `part`. */
function removeRelsTargeting(deck: Deck, part: string): void {
  for (const name of [...deck.parts.keys()]) {
    if (!name.endsWith(".rels")) continue;
    const source = relsSource(name);
    if (source === null) continue;
    const doomed = readRels(deck, source).filter((r) => !r.external && r.resolved === part);
    if (!doomed.length) continue;
    deck.edit(name);
    for (const r of doomed) removeNodeTidy(r.el);
    if (source === deck.presPath || !deck.isXml(source)) continue;
    // Drop hyperlinks in the source part that used the removed relationships.
    const ids = new Set(doomed.map((r) => r.id));
    const root = deck.doc(source).root;
    const kill: XmlElement[] = [];
    const walk = (e: XmlElement) => {
      for (const c of elementChildren(e)) {
        if (HLINK_LOCALS.has(localName(c.name)) && ids.has(getAttr(c, "id", NS.r) ?? "")) kill.push(c);
        else walk(c);
      }
    };
    walk(root);
    if (kill.length) {
      deck.edit(source);
      kill.forEach(removeNode);
    }
  }
}

/** Source part of a rels part ("" for the package rels), or null. */
function relsSource(relsPath: string): string | null {
  if (relsPath === ROOT_RELS) return "";
  const m = /^(.*?)_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (!m) return null;
  return m[1] + m[2];
}

function updateAppSlideCount(deck: Deck): void {
  const rel = readRels(deck, "").find((r) => r.type === REL.extendedProperties);
  if (!rel?.resolved || !deck.has(rel.resolved)) return;
  const root = deck.doc(rel.resolved).root;
  const slides = child(root, NS.ep, "Slides");
  const count = String(deck.slideCount);
  if (slides && textContent(slides) !== count) {
    deck.edit(rel.resolved);
    setTextContent(slides, count);
  }
  const notes = child(root, NS.ep, "Notes");
  if (notes) {
    const n = String(listSlides(deck).filter((s) => s.notesPart).length);
    if (textContent(notes) !== n) {
      deck.edit(rel.resolved);
      setTextContent(notes, n);
    }
  }
}

export function deleteSlide(deck: Deck, index: number): void {
  checkIndex(deck, index);
  if (deck.slideCount === 1) throw new PptxError("Cannot delete the only slide");
  const info = listSlides(deck)[index];
  const candidates = closureFrom(deck, info.part);

  // presentation.xml: sldIdLst, custom shows, sections
  const pres = deck.edit(deck.presPath).root;
  removeNodeTidy(slideIdElements(deck)[index]);
  const custShowLst = child(pres, NS.p, "custShowLst");
  if (custShowLst) {
    for (const sld of descendants(custShowLst, NS.p, "sld")) {
      if (getAttr(sld, "id", NS.r) === info.rId) removeNodeTidy(sld);
    }
  }
  for (const sec of readSections(deck) ?? []) {
    if (sec.ids.includes(String(info.sldId))) writeSectionIds(sec, sec.ids.filter((id) => id !== String(info.sldId)));
  }

  // Relationships pointing at the slide (presentation rels, hyperlinks from other slides).
  removeRelsTargeting(deck, info.part);

  // Remove the slide and whatever only it used.
  const live = reachableParts(deck);
  for (const part of candidates) {
    if (part !== info.part && live.has(part)) continue;
    const rp = relsPathOf(part);
    removeOverride(deck, part);
    deck.removePart(part);
    if (deck.has(rp)) deck.removePart(rp);
  }
  // Parts that pointed at removed parts (e.g. a notes slide shared oddly) keep
  // valid rels: drop relationships whose targets vanished.
  for (const part of live) {
    const rels = readRels(deck, part);
    const gone = rels.filter((r) => !r.external && r.resolved && candidates.has(r.resolved) && !deck.has(r.resolved));
    if (gone.length) {
      deck.edit(relsPathOf(part));
      gone.forEach((r) => removeNodeTidy(r.el));
    }
  }
  updateAppSlideCount(deck);
}

/* ------------------------------------------------------------------ */
/* Duplicate                                                           */
/* ------------------------------------------------------------------ */

/** Next free part name in the same folder, following the name's numbering. */
function nextPartName(deck: Deck, like: string): string {
  const dir = dirname(like);
  const base = basename(like);
  const m = /^(.*?)(\d*)(\.[^.]+)$/.exec(base);
  const stem = m ? m[1] : base;
  const ext = m ? m[3] : "";
  const re = new RegExp("^" + stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)" + ext.replace(/\./g, "\\.") + "$", "i");
  let max = 0;
  for (const name of deck.parts.keys()) {
    if (dirname(name) !== dir) continue;
    const mm = re.exec(basename(name));
    if (mm) max = Math.max(max, Number(mm[1]));
  }
  let n = max + 1;
  const make = (k: number) => (dir ? dir + "/" : "") + stem + k + ext;
  while (deck.has(make(n))) n++;
  return make(n);
}

function randomUint32(): number {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * 0xffffffff);
}

/**
 * Copies `src` to a new part next to it. Owned children are deep-copied,
 * relationships back to `origOwner` are pointed at `newOwner`.
 */
function copyPart(deck: Deck, src: string, dest: string, origOwner: string, copies: Map<string, string>): string {
  copies.set(src, dest);
  const source = deck.parts.get(src)!;
  if (deck.isXml(src)) {
    const d = deck.doc(src);
    deck.addPart(dest, { created: true }, { prolog: d.prolog, root: cloneElement(d.root), epilog: d.epilog });
  } else {
    deck.addPart(dest, "zipName" in source ? { zipName: source.zipName } : source);
  }
  const ct = overrideFor(deck, src);
  if (ct) addOverride(deck, dest, getAttr(ct, "ContentType") ?? "application/xml");

  const rels = readRels(deck, src);
  const rp = relsPathOf(src);
  if (deck.has(rp)) {
    const rd = deck.doc(rp);
    const copy = { prolog: rd.prolog, root: cloneElement(rd.root), epilog: rd.epilog };
    const relsDest = relsPathOf(dest);
    deck.addPart(relsDest, { created: true }, copy);
    const copiedEls = children(copy.root, NS.pr, "Relationship");
    rels.forEach((r, k) => {
      const el = copiedEls[k];
      if (r.external || !r.resolved || !deck.has(r.resolved)) return;
      let target: string | null = null;
      if (r.resolved === origOwner) target = copies.get(origOwner) ?? null;
      else if (copies.has(r.resolved)) target = copies.get(r.resolved)!;
      else if (OWNED_REL_TYPES.has(r.type)) target = copyPart(deck, r.resolved, nextPartName(deck, r.resolved), origOwner, copies);
      if (target) setAttr(el, "Target", relativeTarget(dest, target));
      else if (dirname(dest) !== dirname(src)) setAttr(el, "Target", relativeTarget(dest, r.resolved));
    });
  }
  return dest;
}

export function duplicateSlide(deck: Deck, index: number): number {
  checkIndex(deck, index);
  const info = listSlides(deck)[index];
  const newPart = nextPartName(deck, info.part);
  copyPart(deck, info.part, newPart, info.part, new Map());
  if (!overrideFor(deck, newPart) && contentTypeOf(deck, newPart) === null) {
    addOverride(deck, newPart, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml");
  }

  // Fresh p14:creationId so the copy is a distinct slide to PowerPoint.
  for (const cid of descendants(deck.doc(newPart).root, NS.p14, "creationId")) {
    setAttr(cid, "val", String(randomUint32()));
  }

  const rId = addRel(deck, deck.presPath, REL.slide, newPart);
  const els = slideIdElements(deck);
  let maxId = 255;
  for (const e of els) maxId = Math.max(maxId, Number(getAttr(e, "id")) || 0);
  const newId = maxId + 1;
  if (newId >= 2147483648) throw new PptxError("No free slide id");
  deck.edit(deck.presPath);
  const orig = els[index];
  const el = createElement(orig, NS.p, "sldId");
  insertAfter(orig, el);
  setAttr(el, "id", String(newId));
  setAttrNS(el, NS.r, "id", rId, "r");
  // Keep pretty-printing consistent when the list is indented.
  const parent = orig.parent!;
  const at = parent.children.indexOf(orig);
  const ws = parent.children[at - 1];
  if (ws && ws.type === "text" && !/\S/.test(ws.raw)) parent.children.splice(at + 1, 0, { type: "text", raw: ws.raw });

  for (const sec of readSections(deck) ?? []) {
    const k = sec.ids.indexOf(String(info.sldId));
    if (k >= 0) {
      const ids = [...sec.ids];
      ids.splice(k + 1, 0, String(newId));
      writeSectionIds(sec, ids);
    }
  }
  updateAppSlideCount(deck);
  return index + 1;
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

interface TextTarget {
  info: TextShape;
  txBody: XmlElement;
}

function cNvPrOf(el: XmlElement): XmlElement | null {
  for (const c of elementChildren(el)) {
    if (localName(c.name).startsWith("nv") && c.ns === NS.p) return child(c, NS.p, "cNvPr");
  }
  return null;
}

function placeholderOf(el: XmlElement): string | null {
  for (const nv of elementChildren(el)) {
    if (!(nv.ns === NS.p && localName(nv.name).startsWith("nv"))) continue;
    const nvPr = child(nv, NS.p, "nvPr");
    const ph = nvPr && child(nvPr, NS.p, "ph");
    if (ph) return getAttr(ph, "type") ?? "body";
  }
  return null;
}

export function paragraphText(p: XmlElement): string {
  let s = "";
  for (const c of elementChildren(p)) {
    if (c.ns !== NS.a) continue;
    const ln = localName(c.name);
    if (ln === "r" || ln === "fld") {
      const t = child(c, NS.a, "t");
      if (t) s += textContent(t);
    } else if (ln === "br") {
      s += "\n";
    }
  }
  return s;
}

function spansOf(tc: XmlElement): { colSpan?: number; rowSpan?: number } {
  const n = (v: string | null) => {
    const k = v ? parseInt(v, 10) : 1;
    return Number.isFinite(k) && k > 1 ? Math.min(k, 1000) : undefined;
  };
  const colSpan = n(getAttr(tc, "gridSpan"));
  const rowSpan = n(getAttr(tc, "rowSpan"));
  return { ...(colSpan ? { colSpan } : {}), ...(rowSpan ? { rowSpan } : {}) };
}

/** All text targets on a slide, in document order (mc:Choice and mc:Fallback both included). */
function collectTargets(deck: Deck, index: number): TextTarget[] {
  checkIndex(deck, index);
  const part = listSlides(deck)[index].part;
  const root = deck.doc(part).root;
  const cSld = child(root, NS.p, "cSld");
  const tree = cSld && child(cSld, NS.p, "spTree");
  const out: TextTarget[] = [];
  if (!tree) return out;
  const walk = (container: XmlElement) => {
    for (const el of elementChildren(container)) {
      const ln = localName(el.name);
      if (el.ns === NS.mc && ln === "AlternateContent") {
        for (const branch of elementChildren(el)) walk(branch);
        continue;
      }
      if (el.ns !== NS.p) continue;
      if (ln === "grpSp") {
        walk(el);
      } else if (ln === "sp") {
        const tx = child(el, NS.p, "txBody");
        const nv = cNvPrOf(el);
        if (!tx || !nv) continue;
        const id = getAttr(nv, "id") ?? "";
        out.push({
          txBody: tx,
          info: {
            id,
            shapeId: id,
            name: getAttr(nv, "name") ?? "",
            kind: "shape",
            placeholder: placeholderOf(el),
            paragraphs: children(tx, NS.a, "p").map(paragraphText),
          },
        });
      } else if (ln === "graphicFrame") {
        const nv = cNvPrOf(el);
        const graphic = child(el, NS.a, "graphic");
        const data = graphic && child(graphic, NS.a, "graphicData");
        const tbl = data && child(data, NS.a, "tbl");
        if (!nv || !tbl) continue;
        const fid = getAttr(nv, "id") ?? "";
        children(tbl, NS.a, "tr").forEach((tr, r) => {
          children(tr, NS.a, "tc").forEach((tc, c) => {
            if (getAttr(tc, "hMerge") === "1" || getAttr(tc, "hMerge") === "true") return;
            if (getAttr(tc, "vMerge") === "1" || getAttr(tc, "vMerge") === "true") return;
            const tx = child(tc, NS.a, "txBody");
            if (!tx) return;
            out.push({
              txBody: tx,
              info: {
                id: `${fid}:${r}:${c}`,
                shapeId: fid,
                name: getAttr(nv, "name") ?? "",
                kind: "tableCell",
                row: r,
                col: c,
                ...spansOf(tc),
                placeholder: null,
                paragraphs: children(tx, NS.a, "p").map(paragraphText),
              },
            });
          });
        });
      }
    }
  };
  walk(tree);
  return out;
}

export function getSlideTexts(deck: Deck, index: number): TextShape[] {
  const seen = new Set<string>();
  const out: TextShape[] = [];
  for (const t of collectTargets(deck, index)) {
    if (seen.has(t.info.id)) continue; // mc:Fallback duplicate of a mc:Choice shape
    seen.add(t.info.id);
    out.push(t.info);
  }
  return out;
}

function renameTo(el: XmlElement, local: string): XmlElement {
  const copy = cloneElement(el);
  const p = el.name.includes(":") ? el.name.slice(0, el.name.indexOf(":") + 1) : "";
  copy.name = p + local;
  copy.rawOpen = null;
  copy.rawClose = null;
  return copy;
}

interface ParaTemplate {
  pPr: XmlElement | null;
  rPr: XmlElement | null;
  endParaRPr: XmlElement | null;
}

function templateOf(p: XmlElement): ParaTemplate {
  const pPr = child(p, NS.a, "pPr");
  const endParaRPr = child(p, NS.a, "endParaRPr");
  let rPr: XmlElement | null = null;
  for (const c of elementChildren(p)) {
    if (isEl(c, NS.a, "r") || isEl(c, NS.a, "fld")) {
      rPr = child(c, NS.a, "rPr");
      break;
    }
  }
  if (!rPr && endParaRPr) rPr = renameTo(endParaRPr, "rPr");
  return { pPr, rPr, endParaRPr };
}

function buildParagraphContent(p: XmlElement, tpl: ParaTemplate, text: string): void {
  for (const c of p.children) if (c.type === "element") c.parent = null;
  p.children = [];
  if (tpl.pPr) appendChild(p, cloneElement(tpl.pPr));
  const lines = text.split("\n");
  lines.forEach((line, k) => {
    if (k > 0) {
      const br = createElement(p, NS.a, "br");
      if (tpl.rPr) appendChild(br, cloneElement(tpl.rPr));
      appendChild(p, br);
    }
    if (!line) return;
    const r = createElement(p, NS.a, "r");
    if (tpl.rPr) appendChild(r, cloneElement(tpl.rPr));
    const t = createElement(p, NS.a, "t");
    setTextContent(t, line);
    appendChild(r, t);
    appendChild(p, r);
  });
  if (tpl.endParaRPr) appendChild(p, cloneElement(tpl.endParaRPr));
  else if (!text && tpl.rPr) appendChild(p, renameTo(tpl.rPr, "endParaRPr"));
}

function normalizeText(s: string): string {
  return stripInvalidXmlChars(String(s ?? "").replace(/\r\n?/g, "\n").replace(/\v/g, "\n"));
}

/** A run, field or line break of a paragraph and its share of paragraphText(). */
interface Piece {
  node: XmlElement;
  kind: "r" | "fld" | "br";
  text: string;
  start: number;
}

function piecesOf(p: XmlElement): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const c of elementChildren(p)) {
    if (c.ns !== NS.a) continue;
    const ln = localName(c.name);
    if (ln === "r" || ln === "fld") {
      const t = child(c, NS.a, "t");
      const text = t ? textContent(t) : "";
      out.push({ node: c, kind: ln, text, start: at });
      at += text.length;
    } else if (ln === "br") {
      out.push({ node: c, kind: "br", text: "\n", start: at });
      at += 1;
    }
  }
  return out;
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Runs (with a:br between lines) for `text`, formatted like `rPr`. */
function runsFor(context: XmlElement, rPr: XmlElement | null, text: string): XmlElement[] {
  const out: XmlElement[] = [];
  text.split("\n").forEach((line, k) => {
    if (k > 0) {
      const br = createElement(context, NS.a, "br");
      if (rPr) appendChild(br, cloneElement(rPr));
      out.push(br);
    }
    if (!line) return;
    const r = createElement(context, NS.a, "r");
    if (rPr) appendChild(r, cloneElement(rPr));
    const t = createElement(context, NS.a, "t");
    setTextContent(t, line);
    appendChild(r, t);
    out.push(r);
  });
  return out;
}

function replaceWith(node: XmlElement, nodes: XmlElement[]): void {
  const p = node.parent;
  if (!p) return;
  const idx = p.children.indexOf(node);
  for (const n of nodes) n.parent = p;
  p.children.splice(idx, 1, ...nodes);
  if (!nodes.includes(node)) node.parent = null;
}

/**
 * Sets one paragraph's text, keeping every run the edit doesn't touch: the
 * common start and end of the old and new text stay in their own runs, and
 * the changed middle goes into the run where the change starts (or, for a
 * pure insertion, the run just before it), so retyping one word keeps the
 * bold, colour, size or link of the words around it.
 */
function editParagraph(p: XmlElement, text: string): void {
  const pieces = piecesOf(p);
  const old = pieces.map((x) => x.text).join("");
  if (old === text) return;
  const textual = pieces.filter((x) => x.kind !== "br");
  if (!textual.length) {
    buildParagraphContent(p, templateOf(p), text);
    return;
  }
  const max = Math.min(old.length, text.length);
  let pre = 0;
  while (pre < max && old[pre] === text[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && old[old.length - 1 - suf] === text[text.length - 1 - suf]) suf++;
  // Never split a surrogate pair between kept and replaced text.
  if (pre > 0 && isHighSurrogate(old.charCodeAt(pre - 1))) pre--;
  if (suf > 0 && isLowSurrogate(old.charCodeAt(old.length - suf))) suf--;
  const from = pre;
  const to = old.length - suf;
  const middle = text.slice(pre, text.length - suf);

  const within = (x: Piece, i: number) => x.start <= i && i < x.start + x.text.length;
  let host = from < to ? textual.find((x) => within(x, from)) : undefined;
  if (!host && from > 0) host = textual.find((x) => within(x, from - 1));
  host ??= textual.find((x) => within(x, from));
  // Only line breaks around the change (or an empty run): use the nearest run.
  host ??= [...textual].reverse().find((x) => x.start <= from) ?? textual[0];
  const hostTouches = host.start <= from && from <= host.start + host.text.length;
  let middleDone = !middle;

  for (const x of pieces) {
    const end = x.start + x.text.length;
    if (x.kind === "br") {
      if (from <= x.start && x.start < to) removeNodeTidy(x.node);
      if (!middleDone && !hostTouches && x.start >= from) {
        replaceWith(x.node, [...runsFor(p, child(host.node, NS.a, "rPr"), middle), ...(x.node.parent ? [x.node] : [])]);
        middleDone = true;
      }
      continue;
    }
    const isHost = x === host && hostTouches;
    const touched = isHost || (x.start < to && end > from) || (from === to && x.start < from && from < end);
    if (!touched) {
      if (!middleDone && !hostTouches && x.start >= from) {
        replaceWith(x.node, [...runsFor(p, child(host.node, NS.a, "rPr"), middle), x.node]);
        middleDone = true;
      }
      continue;
    }
    const left = old.slice(x.start, Math.max(x.start, Math.min(end, from)));
    const right = old.slice(Math.min(end, Math.max(x.start, to)), end);
    const value = left + (isHost ? middle : "") + right;
    if (isHost) middleDone = true;
    if (x.kind === "r" && !value.includes("\n")) {
      if (!value) {
        removeNodeTidy(x.node);
        continue;
      }
      const t = child(x.node, NS.a, "t");
      if (t) setTextContent(t, value);
      else {
        const nt = createElement(x.node, NS.a, "t");
        setTextContent(nt, value);
        appendChild(x.node, nt);
      }
      continue;
    }
    // A field whose text changed is plain text now; new lines become a:br.
    replaceWith(x.node, runsFor(p, child(x.node, NS.a, "rPr"), value));
  }
  if (!middleDone) {
    const endMark = child(p, NS.a, "endParaRPr");
    const nodes = runsFor(p, child(host.node, NS.a, "rPr"), middle);
    if (endMark) {
      const idx = p.children.indexOf(endMark);
      for (const n of nodes) n.parent = p;
      p.children.splice(idx, 0, ...nodes);
    } else nodes.forEach((n) => appendChild(p, n));
  }
  if (!text && !child(p, NS.a, "endParaRPr")) {
    const rPr = child(host.node, NS.a, "rPr");
    if (rPr) appendChild(p, renameTo(rPr, "endParaRPr"));
  }
}

/** Pairs of equal entries (old index, new index), as a longest common subsequence. */
function matchLines(a: string[], b: string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) pairs.push([lo, lo++]);
  let ha = a.length;
  let hb = b.length;
  const tail: [number, number][] = [];
  while (ha > lo && hb > lo && a[ha - 1] === b[hb - 1]) tail.unshift([--ha, --hb]);
  const n = ha - lo;
  const m = hb - lo;
  if (n > 0 && m > 0 && n * m <= 1_000_000) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = a[lo + i] === b[lo + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[lo + i] === b[lo + j]) pairs.push([lo + i++, lo + j++]);
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  return [...pairs, ...tail];
}

function stripLinks(rPr: XmlElement | null): XmlElement | null {
  if (!rPr) return rPr;
  const copy = cloneElement(rPr);
  copy.children = copy.children.filter(
    (c) => !(c.type === "element" && c.ns === NS.a && HLINK_LOCALS.has(localName(c.name)))
  );
  copy.rawOpen = null;
  copy.rawClose = null;
  return copy;
}

/**
 * Sets a text body's paragraphs. Paragraphs are matched to the old ones as a
 * diff, so inserting or deleting a line keeps every other paragraph (and its
 * level, bullets and runs) as it was. A new paragraph takes the properties of
 * the one before it, like pressing Enter at its end.
 */
function editTxBody(txBody: XmlElement, paragraphs: string[]): boolean {
  const wanted = (paragraphs.length ? paragraphs : [""]).map(normalizeText);
  const paras = children(txBody, NS.a, "p");
  let changed = false;
  if (!paras.length) {
    const p = createElement(txBody, NS.a, "p");
    appendChild(txBody, p);
    paras.push(p);
    changed = true;
  }
  const before = paras.map(paragraphText);
  if (!changed && before.length === wanted.length && before.every((t, k) => t === wanted[k])) return false;
  // Templates for new paragraphs, taken before anything is edited.
  const templates: ParaTemplate[] = paras.map((p) => {
    const t = templateOf(p);
    return {
      pPr: t.pPr && cloneElement(t.pPr),
      rPr: stripLinks(t.rPr),
      endParaRPr: t.endParaRPr && cloneElement(t.endParaRPr),
    };
  });
  const matches = [...matchLines(before, wanted), [paras.length, wanted.length] as [number, number]];
  let i = 0;
  let j = 0;
  let last: XmlElement | null = null;
  let lastOld = -1;
  for (const [mi, mj] of matches) {
    const common = Math.min(mi - i, mj - j);
    for (let k = 0; k < common; k++) {
      editParagraph(paras[i + k], wanted[j + k]);
      last = paras[i + k];
      lastOld = i + k;
    }
    for (let k = common; k < mj - j; k++) {
      const tplIndex = lastOld >= 0 ? lastOld : Math.min(i + common, paras.length - 1);
      const p = createElement(txBody, NS.a, "p");
      if (last) insertAfter(last, p);
      else {
        const first = paras[0];
        const idx = txBody.children.indexOf(first);
        p.parent = txBody;
        txBody.children.splice(idx, 0, p);
      }
      buildParagraphContent(p, templates[tplIndex], wanted[j + k]);
      last = p;
    }
    for (let k = common; k < mi - i; k++) removeNodeTidy(paras[i + k]);
    if (mi < paras.length) {
      last = paras[mi];
      lastOld = mi;
    }
    i = mi + 1;
    j = mj + 1;
  }
  return true;
}

function alternateContentOf(el: XmlElement): XmlElement | null {
  for (let e: XmlElement | null = el.parent; e; e = e.parent) {
    if (e.ns === NS.mc && localName(e.name) === "AlternateContent") return e;
  }
  return null;
}

export function setShapeText(deck: Deck, index: number, shapeId: string, paragraphs: string[]): void {
  const matches = collectTargets(deck, index).filter((t) => t.info.id === String(shapeId));
  if (!matches.length) throw new PptxError(`No text shape ${shapeId} on slide ${index + 1}`);
  // Edit the shape getSlideTexts lists (the first match) and its alternates in
  // the same mc:AlternateContent; another shape that reuses the id (seen in
  // files from some generators) is a different shape and stays untouched.
  const alt = alternateContentOf(matches[0].txBody);
  const targets = alt ? matches.filter((t) => alternateContentOf(t.txBody) === alt) : [matches[0]];
  const part = listSlides(deck)[index].part;
  let changed = false;
  for (const t of targets) changed = editTxBody(t.txBody, paragraphs) || changed;
  if (changed) deck.edit(part);
}

/** Text of the notes slide body placeholder, or null when the slide has no notes. */
export function getNotesText(deck: Deck, index: number): string[] | null {
  checkIndex(deck, index);
  const notes = listSlides(deck)[index].notesPart;
  if (!notes) return null;
  const root = deck.doc(notes).root;
  for (const sp of descendants(root, NS.p, "sp")) {
    if (placeholderOf(sp) !== "body") continue;
    const tx = child(sp, NS.p, "txBody");
    if (tx) return children(tx, NS.a, "p").map(paragraphText);
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Watermark                                                           */
/* ------------------------------------------------------------------ */

/** p:cNvPr name of the "Made with PDF Wizard" text box (Free edits). */
export const WATERMARK_SHAPE_NAME = "PDF Wizard Watermark";

/**
 * Adds a small text box, bottom-right, to every slide that doesn't have one
 * yet: 8pt grey text at 60% opacity, 10pt from the edges, on top of the
 * slide's own shapes. Nothing else in the slide changes.
 */
export function addWatermark(deck: Deck, text: string): number {
  const { cx, cy } = deck.slideSize;
  const EMU_PT = 12700;
  const margin = 10 * EMU_PT;
  const w = Math.min(cx - 2 * margin, 160 * EMU_PT);
  const h = 14 * EMU_PT;
  const x = Math.max(0, cx - margin - w);
  const y = Math.max(0, cy - margin - h);
  const safe = stripInvalidXmlChars(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let added = 0;
  for (const info of listSlides(deck)) {
    const root = deck.doc(info.part).root;
    const cSld = child(root, NS.p, "cSld");
    const tree = cSld && child(cSld, NS.p, "spTree");
    if (!tree) continue;
    let maxId = 0;
    let present = false;
    for (const c of descendants(root, NS.p, "cNvPr")) {
      maxId = Math.max(maxId, Number(getAttr(c, "id")) || 0);
      if (getAttr(c, "name") === WATERMARK_SHAPE_NAME) present = true;
    }
    if (present) continue;
    const sp = parseXml(
      `<p:sp xmlns:p="${NS.p}" xmlns:a="${NS.a}">` +
        `<p:nvSpPr><p:cNvPr id="${maxId + 1}" name="${WATERMARK_SHAPE_NAME}" descr="${safe}"/>` +
        `<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
        `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="b"><a:noAutofit/></a:bodyPr><a:lstStyle/>` +
        `<a:p><a:pPr algn="r"/><a:r><a:rPr lang="en-US" sz="800" b="0" i="0" u="none" dirty="0">` +
        `<a:solidFill><a:srgbClr val="737373"><a:alpha val="60000"/></a:srgbClr></a:solidFill>` +
        `<a:latin typeface="Arial"/></a:rPr><a:t>${safe}</a:t></a:r></a:p></p:txBody></p:sp>`
    ).root;
    const ext = child(tree, NS.p, "extLst");
    if (ext) {
      const idx = tree.children.indexOf(ext);
      sp.parent = tree;
      tree.children.splice(idx, 0, sp);
    } else {
      appendChild(tree, sp);
    }
    deck.edit(info.part);
    added++;
  }
  return added;
}
