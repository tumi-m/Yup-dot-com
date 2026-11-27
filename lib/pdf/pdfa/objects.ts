/**
 * The document-wide clean-up PDF/A asks for, object by object:
 *
 * - no JavaScript or actions that launch, submit, reset, import, hide or
 *   play anything (6.5), and no additional actions (AA) anywhere;
 * - no attachments in PDF/A-2b (6.8); in PDF/A-3b each is kept and marked
 *   as belonging to the document, with its type;
 * - no external streams, LZW compression (re-encoded as Flate), transfer
 *   functions, halftones, unknown blend modes or rendering intents,
 *   PostScript or reference XObjects, image alternates or interpolation;
 * - hex strings with an odd number of digits, and numbers too small or too
 *   big for PDF/A, written so it accepts them;
 * - metadata streams other than the document's (written afresh elsewhere);
 * - catalog and page keys PDF/A doesn't allow, and optional content
 *   configurations named as it asks.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";
import { decodeLossless, deflate } from "../compress/streams";
import type { Part } from "./metadata";

const N = PDFName.of;

export interface ObjectReport {
  scripts: number;
  actions: number;
  attachments: number;
  lzw: number;
  /** PostScript XObjects, which readers never drew, emptied. */
  postscript: number;
  /** Streams whose data was meant to come from another file. */
  external: number;
  /** Streams that use a filter or external data PDF/A doesn't allow and that couldn't be rewritten. */
  unfixedStreams: number;
}

const ALLOWED_ACTIONS = new Set(["GoTo", "GoToR", "Thread", "URI", "Named"]);
const NAMED_OK = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage"]);
const BLEND = new Set([
  "Normal", "Compatible", "Multiply", "Screen", "Overlay", "Darken", "Lighten", "ColorDodge", "ColorBurn", "HardLight",
  "SoftLight", "Difference", "Exclusion", "Hue", "Saturation", "Color", "Luminosity",
]);
const INTENTS = new Set(["RelativeColorimetric", "AbsoluteColorimetric", "Perceptual", "Saturation"]);

/** A MIME type for an attachment, from its name. */
export function mimeFor(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    pdf: "application/pdf", xml: "application/xml", txt: "text/plain", csv: "text/csv", json: "application/json",
    html: "text/html", htm: "text/html", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    tif: "image/tiff", tiff: "image/tiff", zip: "application/zip", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", md: "text/markdown",
  };
  return known[ext] ?? "application/octet-stream";
}

/** An action with what PDF/A forbids taken out of it and its Next chain; null when nothing allowed is left. */
function cleanAction(ctx: PDFContext, value: PDFObject | undefined, part: Part, report: ObjectReport, depth = 0): PDFObject | null {
  const action = ctx.lookup(value);
  if (!(action instanceof PDFDict) || depth > 32) return null;
  const s = action.lookup(N("S"));
  const kind = s instanceof PDFName ? s.decodeText() : "";
  const named = action.lookup(N("N"));
  const ok =
    (ALLOWED_ACTIONS.has(kind) && (kind !== "Named" || (named instanceof PDFName && NAMED_OK.has(named.decodeText())))) ||
    (kind === "GoToE" && part === 3);
  const next = action.lookup(N("Next"));
  if (next instanceof PDFArray) {
    const left = [];
    for (let i = 0; i < next.size(); i++) {
      const n = cleanAction(ctx, next.get(i), part, report, depth + 1);
      if (n) left.push(n);
    }
    if (left.length) action.set(N("Next"), ctx.obj(left));
    else action.delete(N("Next"));
  } else if (next) {
    const n = cleanAction(ctx, action.get(N("Next")), part, report, depth + 1);
    if (n) action.set(N("Next"), n);
    else action.delete(N("Next"));
  }
  if (ok) return value!;
  if (kind === "JavaScript") report.scripts++;
  else report.actions++;
  // Its Next actions still run in its place.
  const rest = action.get(N("Next"));
  return rest instanceof PDFArray ? (rest.size() ? rest.get(0) : null) : (rest ?? null);
}

/** A hex string with an even number of hex digits (6.1.6). */
function fixHex(h: PDFHexString): PDFHexString | null {
  const raw = h.toString().slice(1, -1);
  if (/^[0-9A-Fa-f]*$/.test(raw) && raw.length % 2 === 0) return null;
  const digits = raw.replace(/[^0-9A-Fa-f]/g, "");
  return PDFHexString.of(digits.length % 2 ? `${digits}0` : digits);
}

/** A number PDF/A accepts (6.1.13): integers within 32 bits, reals not too close to zero or too big. */
function fixNumber(n: PDFNumber): PDFNumber | null {
  const v = n.asNumber();
  if (!Number.isFinite(v)) return PDFNumber.of(0);
  if (v !== 0 && Math.abs(v) < 1.175e-38) return PDFNumber.of(0);
  if (Number.isInteger(v) && (v > 2147483647 || v < -2147483648)) return PDFNumber.of(v > 0 ? 2147483647 : -2147483648);
  if (Math.abs(v) > 3.4e38) return PDFNumber.of(v > 0 ? 3.4e38 : -3.4e38);
  return null;
}

/** Re-encodes an LZW stream with Flate, keeping its predictor and the filters after it. False when it can't be read. */
function reencodeLzw(ctx: PDFContext, ref: PDFRef, stream: PDFRawStream): boolean {
  const decoded = decodeLossless(ctx, stream);
  if (!decoded) return false;
  const dict = stream.dict.clone(ctx);
  const filters = [N("FlateDecode"), ...decoded.rest.names.map((n) => N(n))];
  let first: PDFObject = PDFNull;
  if (decoded.predictor) {
    const p = decoded.predictor.clone(ctx);
    p.delete(N("EarlyChange"));
    first = p;
  }
  const parms = [first, ...decoded.rest.parms.map((p) => p ?? PDFNull)];
  dict.set(N("Filter"), filters.length === 1 ? filters[0] : ctx.obj(filters));
  if (parms.every((p) => p === PDFNull)) dict.delete(N("DecodeParms"));
  else dict.set(N("DecodeParms"), parms.length === 1 ? parms[0] : ctx.obj(parms));
  dict.delete(N("DP"));
  ctx.assign(ref, PDFRawStream.of(dict, deflate(decoded.bytes)));
  return true;
}

function filterNames(dict: PDFDict): string[] {
  const f = dict.lookup(N("Filter"));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return Array.from({ length: f.size() }, (_, i) => f.lookup(i)).map((x) => (x instanceof PDFName ? x.decodeText() : ""));
  return [];
}

const STREAM_FILTERS = new Set(["ASCIIHexDecode", "ASCII85Decode", "FlateDecode", "RunLengthDecode", "CCITTFaxDecode", "JBIG2Decode", "DCTDecode", "JPXDecode", "LZWDecode"]);

/** A resource list (fonts, XObjects…) names its entries freely: one may be called "A" or "BM". */
const isResourceList = (dict: PDFDict) =>
  dict.values().some((v) => {
    const o = dict.context.lookup(v);
    const d = o instanceof PDFStream ? o.dict : o;
    return d instanceof PDFDict && [N("Font"), N("XObject"), N("ExtGState"), N("Pattern")].includes(d.lookup(N("Type")) as PDFName);
  });

const isExtGState = (dict: PDFDict) =>
  dict.lookup(N("Type")) === N("ExtGState") ||
  (!dict.has(N("Type")) && !dict.has(N("S")) && ["TR", "TR2", "HT", "HTP", "BM"].some((k) => dict.has(N(k))) && !isResourceList(dict));

/** An action dictionary (it has its type, S). */
const isAction = (ctx: PDFContext, v: PDFObject | undefined) => {
  const d = ctx.lookup(v);
  return d instanceof PDFDict && d.lookup(N("S")) instanceof PDFName;
};

/** Every fix in the list at the top of the file, over every object. */
export function cleanObjects(doc: PDFDocument, part: Part, report: ObjectReport, attached: PDFRef[]) {
  const ctx = doc.context;
  const catalogRef = ctx.trailerInfo.Root;

  /**
   * The fixes for one dictionary, then for the dictionaries it holds
   * directly. Returns a reference when it made the dictionary an object of
   * its own, which its holder then points at.
   */
  const visit = (dict: PDFDict, ref: PDFRef | null, depth: number): PDFRef | null => {
    if (depth > 32) return null;
    const list = isResourceList(dict);
    // Actions, wherever they hang.
    for (const key of ["A", "OpenAction"]) {
      const v = dict.get(N(key));
      if (!v || list || !isAction(ctx, v)) continue;
      const left = cleanAction(ctx, v, part, report);
      if (left) dict.set(N(key), left);
      else dict.delete(N(key));
    }
    const aa = dict.lookup(N("AA"));
    if (aa instanceof PDFDict && !list && aa.values().every((a) => isAction(ctx, a))) {
      for (const [, a] of aa.entries()) {
        const action = ctx.lookup(a);
        if (action instanceof PDFDict && action.lookup(N("S")) === N("JavaScript")) report.scripts++;
        else report.actions++;
      }
      dict.delete(N("AA"));
    }
    // Other metadata streams than the document's.
    if (ref !== catalogRef && dict.lookup(N("Metadata")) instanceof PDFStream && !list) dict.delete(N("Metadata"));

    // Attached files: gone in PDF/A-2b; in PDF/A-3b marked as the document's.
    if (dict.lookup(N("EF")) instanceof PDFDict && !list) {
      if (part === 2) {
        dict.delete(N("EF"));
        dict.delete(N("RF"));
        report.attachments++;
      } else {
        const name = dict.lookup(N("UF")) ?? dict.lookup(N("F"));
        const text = name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : "attachment";
        if (!dict.has(N("F"))) dict.set(N("F"), PDFString.of(text));
        if (!dict.has(N("UF"))) dict.set(N("UF"), PDFHexString.fromText(text));
        if (!(dict.lookup(N("AFRelationship")) instanceof PDFName)) dict.set(N("AFRelationship"), N("Unspecified"));
        const ef = dict.lookup(N("EF"));
        const file = ef instanceof PDFDict ? ef.lookup(N("F")) : undefined;
        if (file instanceof PDFStream) {
          const sub = file.dict.lookup(N("Subtype"));
          if (!(sub instanceof PDFName) || !/^[-\w+.]+\/[-\w+.]+$/.test(sub.decodeText())) file.dict.set(N("Subtype"), N(mimeFor(text)));
          const params = file.dict.lookup(N("Params"));
          if (!(params instanceof PDFDict)) file.dict.set(N("Params"), ctx.obj({ ModDate: PDFString.fromDate(new Date()) }));
          else if (!params.has(N("ModDate"))) params.set(N("ModDate"), PDFString.fromDate(new Date()));
        }
        // Listed in the catalog's AF, which needs it as an object of its own.
        if (!ref) {
          const made = ctx.register(dict);
          attached.push(made);
          return made;
        }
        attached.push(ref);
      }
    }

    // Graphics state.
    if (isExtGState(dict)) {
      dict.delete(N("TR"));
      if (dict.has(N("TR2")) && dict.lookup(N("TR2")) !== N("Default")) dict.delete(N("TR2"));
      dict.delete(N("HTP"));
      // Halftones only matter to printers, and PDF/A limits them: readers draw the same without.
      dict.delete(N("HT"));
      const bm = dict.lookup(N("BM"));
      const names = bm instanceof PDFArray ? Array.from({ length: bm.size() }, (_, i) => bm.lookup(i)) : [bm];
      if (bm !== undefined && !names.every((b) => b instanceof PDFName && BLEND.has(b.decodeText()))) dict.set(N("BM"), N("Normal"));
      const opm = dict.lookup(N("OPM"));
      if (opm instanceof PDFNumber && opm.asNumber() === 1) dict.set(N("OPM"), PDFNumber.of(0));
    }
    for (const key of ["RI", "Intent"]) {
      const v = dict.lookup(N(key));
      if (v instanceof PDFName && !INTENTS.has(v.decodeText())) dict.delete(N(key));
    }
    for (const [key, v] of dict.entries()) {
      if (v instanceof PDFHexString) {
        const fixed = fixHex(v);
        if (fixed) dict.set(key, fixed);
      } else if (v instanceof PDFNumber) {
        const fixed = fixNumber(v);
        if (fixed) dict.set(key, fixed);
      } else if (v instanceof PDFDict) {
        const made = visit(v, null, depth + 1);
        if (made) dict.set(key, made);
      } else if (v instanceof PDFArray) fixArray(v, depth + 1);
    }
    return null;
  };

  const fixArray = (arr: PDFArray, depth: number) => {
    if (depth > 32) return;
    for (let i = 0; i < arr.size(); i++) {
      const v = arr.get(i);
      if (v instanceof PDFHexString) {
        const fixed = fixHex(v);
        if (fixed) arr.set(i, fixed);
      } else if (v instanceof PDFNumber) {
        const fixed = fixNumber(v);
        if (fixed) arr.set(i, fixed);
      } else if (v instanceof PDFDict) {
        const made = visit(v, null, depth + 1);
        if (made) arr.set(i, made);
      } else if (v instanceof PDFArray) fixArray(v, depth + 1);
    }
  };

  for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
    if (obj instanceof PDFArray) fixArray(obj, 0);
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    visit(dict, ref, 0);
    if (!(obj instanceof PDFStream)) continue;

    // External data: PDF/A keeps everything inside the file (6.1.7.1).
    if (dict.has(N("F")) || dict.has(N("FFilter")) || dict.has(N("FDecodeParms"))) {
      dict.delete(N("F"));
      dict.delete(N("FFilter"));
      dict.delete(N("FDecodeParms"));
      report.external++;
    }
    const subtype = dict.lookup(N("Subtype"));
    if (subtype === N("Image")) {
      dict.delete(N("Alternates"));
      dict.delete(N("OPI"));
      if (dict.lookup(N("Interpolate")) instanceof PDFBool) dict.set(N("Interpolate"), PDFBool.False);
      if (dict.lookup(N("ImageMask")) === PDFBool.True && dict.has(N("BitsPerComponent"))) dict.set(N("BitsPerComponent"), PDFNumber.of(1));
    } else if (subtype === N("Form")) {
      dict.delete(N("Ref"));
      dict.delete(N("OPI"));
      dict.delete(N("PS"));
      if (dict.lookup(N("Subtype2")) === N("PS")) dict.delete(N("Subtype2"));
    } else if (subtype === N("PS")) {
      // A PostScript XObject readers never draw: an empty form in its place.
      ctx.assign(ref, ctx.formXObject([], { BBox: [0, 0, 0, 0] }));
      report.postscript++;
      continue;
    }
    const filters = filterNames(dict);
    if (filters.includes("LZWDecode") && obj instanceof PDFRawStream) {
      if (reencodeLzw(ctx, ref, obj)) report.lzw++;
      else report.unfixedStreams++;
    } else if (filters.some((f) => !STREAM_FILTERS.has(f))) report.unfixedStreams++;
  }
}

/** Catalog, name tree, page and optional content keys PDF/A doesn't allow, and the attachments' list. */
export function cleanCatalog(doc: PDFDocument, part: Part, report: ObjectReport, attached: PDFRef[]) {
  const ctx = doc.context;
  const catalog = doc.catalog;
  for (const key of ["Requirements", "NeedsRendering", "Perms", "Collection"]) {
    if (key === "Collection" && part === 3) continue;
    catalog.delete(N(key));
  }
  const version = catalog.lookup(N("Version"));
  if (version instanceof PDFName && parseFloat(version.decodeText()) > 1.7) catalog.delete(N("Version"));
  const names = catalog.lookup(N("Names"));
  if (names instanceof PDFDict) {
    if (names.has(N("JavaScript"))) {
      report.scripts += Math.max(1, countNames(ctx, names.lookup(N("JavaScript"))));
      names.delete(N("JavaScript"));
    }
    names.delete(N("AlternatePresentations"));
    names.delete(N("Renditions"));
    if (part === 2) names.delete(N("EmbeddedFiles"));
  }
  if (part === 3 && attached.length) {
    // Each attachment belongs to the document (6.8): the catalog lists them in AF.
    const af = catalog.lookup(N("AF"));
    const list = af instanceof PDFArray ? af.asArray() : [];
    for (const ref of attached) if (!list.includes(ref)) list.push(ref);
    catalog.set(N("AF"), ctx.obj(list));
  } else if (part === 2) catalog.delete(N("AF"));
  for (const page of doc.getPages()) {
    page.node.delete(N("PresSteps"));
    page.node.delete(N("AA"));
  }
  fixOptionalContent(doc);
}

function countNames(ctx: PDFContext, tree: PDFObject | undefined, depth = 0): number {
  const node = ctx.lookup(tree);
  if (!(node instanceof PDFDict) || depth > 16) return 0;
  const names = node.lookup(N("Names"));
  let n = names instanceof PDFArray ? Math.floor(names.size() / 2) : 0;
  const kids = node.lookup(N("Kids"));
  if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) n += countNames(ctx, kids.get(i), depth + 1);
  return n;
}

/** Optional content configurations: each named, names unique, no AS, Order listing every layer (6.9). */
function fixOptionalContent(doc: PDFDocument) {
  const ctx = doc.context;
  const oc = doc.catalog.lookup(N("OCProperties"));
  if (!(oc instanceof PDFDict)) return;
  const ocgs = oc.lookup(N("OCGs"));
  const all = ocgs instanceof PDFArray ? ocgs.asArray().filter((r) => r instanceof PDFRef) : [];
  const configs: PDFDict[] = [];
  const d = oc.lookup(N("D"));
  if (d instanceof PDFDict) configs.push(d);
  else {
    const made = ctx.obj({ Name: PDFString.of("Default") });
    oc.set(N("D"), made);
    configs.push(made);
  }
  const more = oc.lookup(N("Configs"));
  if (more instanceof PDFArray) for (let i = 0; i < more.size(); i++) {
    const c = more.lookup(i);
    if (c instanceof PDFDict) configs.push(c);
  }
  const used = new Set<string>();
  configs.forEach((c, i) => {
    const name = c.lookup(N("Name"));
    let text = name && "decodeText" in name ? (name as PDFString).decodeText() : "";
    if (!text || used.has(text)) {
      let n = i + 1;
      text = i === 0 ? "Default" : `Configuration ${n}`;
      while (used.has(text)) text = `Configuration ${++n}`;
      c.set(N("Name"), PDFHexString.fromText(text));
    }
    used.add(text);
    c.delete(N("AS"));
    const order = c.lookup(N("Order"));
    if (order instanceof PDFArray) {
      const listed = new Set<PDFObject>();
      const collect = (a: PDFArray, depth: number) => {
        for (let k = 0; k < a.size() && depth < 16; k++) {
          const v = a.get(k);
          if (v instanceof PDFArray) collect(v, depth + 1);
          else listed.add(v);
        }
      };
      collect(order, 0);
      for (const ref of all) if (!listed.has(ref)) order.push(ref);
    }
  });
}
