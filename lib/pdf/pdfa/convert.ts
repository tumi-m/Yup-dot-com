/**
 * The pdf-lib part of PDF to PDF/A, run in a worker (worker.ts). In order:
 *
 * 1. Open the file, removing its encryption (a file that needs a password
 *    to open is opened with the one given).
 * 2. Flatten its form fields into the page, with their own appearance
 *    (lib/pdf/flatten), and give comments and links what PDF/A asks
 *    (annotations.ts).
 * 3. Take out what PDF/A forbids (objects.ts).
 * 4. Read every content stream (content.ts): undefined operators are cut,
 *    fonts that aren't embedded get a substitute (fonts.ts), and pages that
 *    can't be fixed in place are noted.
 * 5. Add the colour profile (colour.ts).
 * 6. If no page needs to become a picture, write the metadata (metadata.ts),
 *    save and check (check.ts). Otherwise hand the pages back to be drawn on
 *    the page with pdf.js (index.ts), and finish once they are.
 */
import { PDFArray, PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFRadioGroup, PDFRawStream, PDFRef, PDFStream, type PDFObject } from "pdf-lib";
import { flattenDocument } from "../flatten";
import { dropUnreachable } from "../operations";
import { deflate } from "../compress/streams";
import { stopIfAborted } from "../../abort";
import { dropDeadLinks, fixAnnotations, type AnnotationReport } from "./annotations";
import { cleanCatalog, cleanObjects, type ObjectReport } from "./objects";
import { pageContent, readContent, streamBytes, type ContentFacts, type PageProblem } from "./content";
import { addDefaults, fixGroupSpace, fixInputProfiles, jpxBytes, jpxOk, namesDevice, setOutputIntent, srgbRef, type Intent } from "./colour";
import { SubstituteFiles, fixInPlace, isEmbedded, isStandard14, plainName, substitute, type FontFiles, type Substitution } from "./fonts";
import { claimedPdfa, writeMetadata, type Part } from "./metadata";
import { checkPdfa, type CheckResult } from "./check";
import { splicePictures } from "./splice";

const N = PDFName.of;

export const NEEDS_PASSWORD = "This PDF needs its password to open. Type it under Password, then convert it again.";
export const WRONG_PASSWORD = "That password didn't open this PDF. Check it and try again.";
export const NO_PAGES = "This PDF has no pages.";

/** A password problem, said to the person as it is. */
export class PasswordError extends Error {}

export type PictureReason = "font" | PageProblem | "field" | "image";

export interface PdfaFacts {
  part: Part;
  pages: number;
  /** The file was encrypted: only restricted (it opened without a password), or locked with one. */
  encrypted: "restricted" | "password" | null;
  /** What the file said it was before ("PDF/A-1b"), if anything. */
  claimed: string | null;
  /** Form fields flattened, and digital signatures among them. */
  fields: number;
  signatures: number;
  annotations: AnnotationReport;
  objects: ObjectReport;
  substituted: Substitution[];
  /** Pages (0-based) drawn as pictures, why, and the font that made it so. */
  pictures: { page: number; why: PictureReason; font?: string }[];
  /** The output intent: our sRGB, or the RGB or CMYK profile the file had. */
  intent: "srgb" | "kept-rgb" | "kept-cmyk";
  /** Operators PDF doesn't define, cut out. */
  cuts: number;
  /** Colour profiles PDF/A doesn't accept that couldn't be replaced. */
  badProfiles: number;
}

export interface PdfaResult {
  bytes: Uint8Array;
  facts: PdfaFacts;
  checks: CheckResult[];
}

export type Prepared =
  | { kind: "done"; result: PdfaResult }
  | { kind: "pictures"; vector: Uint8Array; pages: number[]; facts: PdfaFacts };

export interface PrepareOptions {
  part: Part;
  password?: string;
  fonts: FontFiles;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

/** Opens the file, decrypted; a file that needs a password is opened with `password`. */
async function open(bytes: Uint8Array, password: string | undefined): Promise<{ doc: PDFDocument; encrypted: PdfaFacts["encrypted"] }> {
  try {
    return { doc: await PDFDocument.load(bytes, { updateMetadata: false }), encrypted: null };
  } catch (err) {
    if (!/encrypted/i.test(err instanceof Error ? err.message : "")) throw err;
  }
  const { unlockPdf } = await import("../security");
  const load = async (plain: Uint8Array) => PDFDocument.load(plain, { updateMetadata: false });
  try {
    return { doc: await load(await unlockPdf(bytes, "")), encrypted: "restricted" };
  } catch {
    // It needs its password to open.
  }
  if (!password) throw new PasswordError(NEEDS_PASSWORD);
  let plain: Uint8Array;
  try {
    plain = await unlockPdf(bytes, password);
  } catch {
    throw new PasswordError(WRONG_PASSWORD);
  }
  return { doc: await load(plain), encrypted: "password" };
}

/** Non-embedded symbol fonts a checkbox or radio button draws its mark with (ZapfDingbats, usually). */
function drawsWithSymbolFont(doc: PDFDocument, widget: PDFDict): boolean {
  const ap = widget.lookup(N("AP"));
  const n = ap instanceof PDFDict ? ap.lookup(N("N")) : undefined;
  const streams: PDFStream[] = n instanceof PDFStream ? [n] : [];
  if (n instanceof PDFDict) for (const [, v] of n.entries()) {
    const s = doc.context.lookup(v);
    if (s instanceof PDFStream) streams.push(s);
  }
  return streams.some((s) => {
    const fonts = (s.dict.lookup(N("Resources")) as PDFDict | undefined)?.lookup(N("Font"));
    if (!(fonts instanceof PDFDict)) return false;
    return fonts.entries().some(([, f]) => {
      const font = doc.context.lookup(f);
      return font instanceof PDFDict && !isEmbedded(font) && ["ZapfDingbats", "Symbol"].includes(plainName(font));
    });
  });
}

/**
 * Checkboxes and radio buttons whose mark is a letter of ZapfDingbats, which
 * has no free stand-in: their pictures are drawn again with pdf-lib's mark
 * (lines, no font), so their pages needn't become pictures.
 */
function redrawButtons(doc: PDFDocument) {
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch {
    return;
  }
  for (const field of fields) {
    if (!(field instanceof PDFCheckBox || field instanceof PDFRadioGroup)) continue;
    if (!field.acroField.getWidgets().some((w) => drawsWithSymbolFont(doc, w.dict))) continue;
    try {
      field.defaultUpdateAppearances();
    } catch {
      // Left as it was: its page becomes a picture if the font can't be embedded.
    }
  }
}

function countSignatures(doc: PDFDocument): number {
  try {
    return doc.getForm().getFields().filter((f) => f.acroField.dict.lookup(N("FT")) === N("Sig") && f.acroField.dict.has(N("V"))).length;
  } catch {
    return 0;
  }
}

/** Cuts `ranges` out of `bytes`. */
function cut(bytes: Uint8Array, ranges: [number, number][]): Uint8Array {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const [a, b] of sorted) {
    if (a < at) continue;
    parts.push(bytes.subarray(at, a), Uint8Array.of(32));
    at = b;
  }
  parts.push(bytes.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Writes the content streams with operators PDF doesn't define cut out. Returns how many were cut. */
function applyCuts(doc: PDFDocument, facts: ContentFacts): number {
  const ctx = doc.context;
  let count = 0;
  for (const [owner, ranges] of facts.cuts) {
    count += ranges.length;
    if (typeof owner === "number") {
      const page = doc.getPage(owner);
      const { bytes } = pageContent(doc, owner);
      page.node.set(N("Contents"), ctx.register(ctx.flateStream(cut(bytes, ranges))));
      continue;
    }
    const bytes = streamBytes(owner);
    if (!bytes) continue;
    const ref = refOf(doc, owner);
    const dict = owner.dict.clone(ctx);
    dict.delete(N("Filter"));
    dict.delete(N("DecodeParms"));
    dict.set(N("Filter"), N("FlateDecode"));
    const fresh = PDFRawStream.of(dict, deflate(cut(bytes, ranges)));
    if (ref) ctx.assign(ref, fresh);
  }
  return count;
}

const refCache = new WeakMap<PDFDocument, Map<PDFObject, PDFRef>>();
function refOf(doc: PDFDocument, obj: PDFObject): PDFRef | undefined {
  let map = refCache.get(doc);
  if (!map) {
    map = new Map();
    for (const [ref, o] of doc.context.enumerateIndirectObjects()) map.set(o, ref);
    refCache.set(doc, map);
  }
  return map.get(obj);
}

/** Pages (0-based) whose widgets are still there after flattening: their fields stayed. */
function pagesWithWidgets(doc: PDFDocument): number[] {
  return doc.getPages().flatMap((page, i) => {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) return [];
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k);
      if (a instanceof PDFDict && a.lookup(N("Subtype")) === N("Widget")) return [i];
    }
    return [];
  });
}

/** Steps 1–5, and 6 when no page needs a picture. */
export async function preparePdfa(bytes: Uint8Array, opts: PrepareOptions): Promise<Prepared> {
  const progress = opts.onProgress ?? (() => {});
  progress(0.02, "Reading the file…");
  const { doc, encrypted } = await open(bytes, opts.password);
  const pages = doc.getPageCount();
  if (!pages) throw new Error(NO_PAGES);
  stopIfAborted(opts.signal);
  const facts: PdfaFacts = {
    part: opts.part,
    pages,
    encrypted,
    claimed: claimedPdfa(doc),
    fields: 0,
    signatures: 0,
    annotations: { media: 0, attachments: 0, hidden: 0, blank: 0, drawn: 0 },
    objects: { scripts: 0, actions: 0, attachments: 0, lzw: 0, postscript: 0, external: 0, unfixedStreams: 0 },
    substituted: [],
    pictures: [],
    intent: "srgb",
    cuts: 0,
    badProfiles: 0,
  };
  const picture = (page: number, why: PictureReason, font?: string) => {
    if (!facts.pictures.some((p) => p.page === page)) facts.pictures.push({ page, why, ...(font ? { font } : {}) });
  };

  progress(0.08, "Flattening form fields…");
  if (doc.catalog.lookup(N("AcroForm")) instanceof PDFDict) {
    facts.signatures = countSignatures(doc);
    redrawButtons(doc);
    const flat = await flattenDocument(doc, "forms", { signal: opts.signal });
    facts.fields = flat.fields + flat.keptFields;
    // Fields whose letters the standard font can't write stay fillable: their pages become pictures.
    for (const p of pagesWithWidgets(doc)) picture(p, "field");
  }
  stopIfAborted(opts.signal);
  progress(0.15, "Checking comments and links…");
  facts.annotations = await fixAnnotations(doc, opts.part);
  const attached: PDFRef[] = [];
  cleanObjects(doc, opts.part, facts.objects, attached);
  cleanCatalog(doc, opts.part, facts.objects, attached);
  dropDeadLinks(doc);
  dropUnreachable(doc);
  stopIfAborted(opts.signal);

  progress(0.25, "Reading the pages…");
  let content = readContent(doc);
  facts.cuts = applyCuts(doc, content);
  if (facts.cuts) content = readContent(doc);
  for (const [stream, inherited] of content.orphans) stream.dict.set(N("Resources"), inherited);
  for (const [page, why] of content.problems) picture(page, why);
  stopIfAborted(opts.signal);

  progress(0.35, "Embedding fonts…");
  const files = new SubstituteFiles(opts.fonts);
  const uses = [...content.fonts.values()];
  for (let i = 0; i < uses.length; i++) {
    stopIfAborted(opts.signal);
    if (uses.length > 4) progress(0.35 + (0.4 * i) / uses.length, `Embedding fonts (${i + 1} of ${uses.length})…`);
    const use = uses[i];
    const name = plainName(use.dict) || "an unnamed font";
    const pagesOf = () => [...use.pages].sort((a, b) => a - b);
    if (isEmbedded(use.dict)) {
      if (!fixInPlace(use.dict)) for (const p of pagesOf()) picture(p, "font", name);
      continue;
    }
    // Drawn only invisibly (OCR text): no program needed, if the font is otherwise sound.
    if (!use.shown.size && !use.composite && fixInPlace(use.dict)) continue;
    if (!use.shown.size && use.composite) continue;
    const done = await substitute(doc, use, files);
    if (done) {
      if (!facts.substituted.some((s) => s.from === done.from && s.to === done.to)) facts.substituted.push(done);
      continue;
    }
    for (const p of pagesOf()) picture(p, "font", isStandard14(use.dict) || name ? name : undefined);
  }

  progress(0.78, "Checking pictures and colours…");
  for (const [image, pagesUsing] of content.images) {
    const bpc = image.dict.lookup(N("BitsPerComponent"));
    const mask = image.dict.lookup(N("ImageMask"));
    const badDepth = bpc !== undefined && !mask && ![1, 2, 4, 8, 16].includes(Number(bpc.toString()));
    const jpx = jpxBytes(image);
    const badJpx = jpx && !jpxOk(jpx, image.dict.has(N("ColorSpace")));
    if (badDepth || badJpx) for (const p of pagesUsing) picture(p, "image");
  }
  facts.badProfiles = fixInputProfiles(doc);
  const intent = setOutputIntent(doc);
  facts.intent = intent.ours ? "srgb" : intent.space === "CMYK" ? "kept-cmyk" : "kept-rgb";
  const named = namesDevice(doc);
  addDefaults(doc, intent, content.resources, { cmyk: named.cmyk || content.deviceCmyk, rgb: named.rgb || content.deviceRgb });
  fixGroups(doc, intent);
  facts.pictures.sort((a, b) => a.page - b.page);
  stopIfAborted(opts.signal);

  if (!facts.pictures.length) return { kind: "done", result: await complete(doc, facts, opts) };
  progress(0.85, "Saving…");
  const vector = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
  return { kind: "pictures", vector, pages: facts.pictures.map((p) => p.page), facts };
}

/** Transparency groups of pages and forms, blending in a colour space the output intent covers. */
function fixGroups(doc: PDFDocument, intent: Intent) {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    const group = dict?.lookup(N("Group"));
    if (group instanceof PDFDict && group.lookup(N("S")) === N("Transparency")) fixGroupSpace(group, doc, intent);
  }
}

/** Step 6 after the pictures: puts them in their pages' places and finishes. */
export async function finishPdfa(vector: Uint8Array, pictures: Uint8Array, facts: PdfaFacts, opts: Omit<PrepareOptions, "fonts" | "password">): Promise<PdfaResult> {
  const doc = await PDFDocument.load(vector, { updateMetadata: false });
  const pics = await PDFDocument.load(pictures, { updateMetadata: false });
  await splicePictures(doc, pics, facts.pictures.map((p) => p.page));
  if (facts.intent === "kept-cmyk") {
    // The pictures are RGB: under a CMYK output intent they need sRGB as their default.
    const intent = { ref: srgbRef(doc), space: "CMYK" as const, ours: false };
    const resources = facts.pictures.map((p) => doc.getPage(p.page).node.Resources()).filter((r): r is PDFDict => !!r);
    addDefaults(doc, intent, resources, { cmyk: false, rgb: true });
  }
  return complete(doc, facts, opts);
}

/** Metadata, what's left of the form, saving and our own check. */
async function complete(doc: PDFDocument, facts: PdfaFacts, opts: Omit<PrepareOptions, "fonts" | "password">): Promise<PdfaResult> {
  const progress = opts.onProgress ?? (() => {});
  progress(0.92, "Writing the PDF/A file…");
  // Every field is part of its page now, as a picture or flattened.
  doc.catalog.delete(N("AcroForm"));
  writeMetadata(doc, facts.part);
  dropUnreachable(doc);
  stopIfAborted(opts.signal);
  const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
  progress(0.97, "Checking the result…");
  const checks = await checkPdfa(bytes, facts.part);
  return { bytes, facts, checks };
}
