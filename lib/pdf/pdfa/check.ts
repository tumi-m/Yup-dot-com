/**
 * Our own check of a finished file against the PDF/A rules this tool puts
 * right: it reads the saved bytes again and looks. It is not a certified
 * validator (veraPDF is the free one for that), and it checks only what is
 * listed here.
 */
import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from "pdf-lib";
import { readContent, streamBytes } from "./content";
import { goodInputProfile, goodOutputProfile, readProfile } from "./colour";
import { descriptorOf, isEmbedded, isStandard14 } from "./fonts";
import { TrueTypeFont } from "./truetype";
import type { Part } from "./metadata";

const N = PDFName.of;

export type CheckId = "file" | "metadata" | "colour" | "fonts" | "actions" | "attachments" | "annotations" | "forms" | "content";

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /** What failed, for people, when it did. */
  problem?: string;
  /** Pages (1-based) the problem is on, when it is on pages. */
  pages?: number[];
}

const ALLOWED_ACTIONS = new Set(["GoTo", "GoToR", "Thread", "URI", "Named"]);
const ANNOTS = new Set([
  "Text", "Link", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine", "Highlight", "Underline", "Squiggly",
  "StrikeOut", "Stamp", "Caret", "Ink", "Popup", "FileAttachment", "Widget", "PrinterMark", "TrapNet", "Watermark", "Redact",
]);
const BAD_FILTERS = new Set(["LZWDecode", "Crypt"]);

/** The checks, in the order the report shows them. */
export async function checkPdfa(bytes: Uint8Array, part: Part): Promise<CheckResult[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const out: CheckResult[] = [];
  const add = (id: CheckId, problem: string | null, pages?: number[]) =>
    out.push(problem ? { id, ok: false, problem, ...(pages?.length ? { pages } : {}) } : { id, ok: true });

  // File: header, identifier, no encryption, nothing after the end.
  const head = String.fromCharCode(...bytes.subarray(0, 14));
  const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 8)));
  const high = bytes.subarray(head.indexOf("\n") + 2, head.indexOf("\n") + 6);
  const id = ctx.lookup(ctx.trailerInfo.ID);
  add(
    "file",
    !/^%PDF-1\.[0-7]\r?\n%/.test(head) || high.length < 4 || [...high].some((b) => b <= 127)
      ? "The file's header isn't one PDF/A accepts."
      : !(id instanceof PDFArray) || id.size() < 2
        ? "The file has no identifier."
        : ctx.trailerInfo.Encrypt
          ? "The file is still encrypted."
          : !/%%EOF\r?\n?$/.test(tail)
            ? "There is data after the end of the file."
            : null
  );

  // Metadata: an XMP packet naming the part and level, uncompressed, matching Info.
  const meta = doc.catalog.lookup(N("Metadata"));
  const xmp = meta instanceof PDFStream ? new TextDecoder().decode(streamBytes(meta) ?? new Uint8Array()) : "";
  const title = (() => {
    try {
      return doc.getTitle();
    } catch {
      return undefined;
    }
  })();
  add(
    "metadata",
    !(meta instanceof PDFStream) || meta.dict.lookup(N("Type")) !== N("Metadata") || meta.dict.lookup(N("Subtype")) !== N("XML")
      ? "There is no XMP metadata."
      : !new RegExp(`<pdfaid:part>${part}</pdfaid:part>`).test(xmp) || !/<pdfaid:conformance>B<\/pdfaid:conformance>/.test(xmp)
        ? `The metadata doesn't say PDF/A-${part}b.`
        : /<\?xpacket[^>]*\b(bytes|encoding)=/.test(xmp)
          ? "The XMP packet header has attributes PDF/A forbids."
          : title && !xmp.includes(title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"))
            ? "The title in the metadata doesn't match the document's."
            : null
  );

  // Colour: one PDF/A output intent with a sound profile; ICC-based colour spaces sound.
  const intents = doc.catalog.lookup(N("OutputIntents"));
  let colour: string | null = "There is no PDF/A output intent.";
  if (intents instanceof PDFArray) {
    const list = Array.from({ length: intents.size() }, (_, i) => intents.lookup(i)).filter((d): d is PDFDict => d instanceof PDFDict);
    const pdfa = list.find((d) => d.lookup(N("S")) === N("GTS_PDFA1"));
    const profiles = new Set(list.map((d) => d.get(N("DestOutputProfile"))).filter(Boolean));
    const prof = pdfa?.lookup(N("DestOutputProfile"));
    if (pdfa && prof instanceof PDFStream && goodOutputProfile(readProfile(streamBytes(prof)))) colour = profiles.size === 1 ? null : "Output intents use different profiles.";
    else if (pdfa) colour = "The output intent's profile isn't one PDF/A accepts.";
  }

  // One pass over every object for what may hang anywhere.
  let action: string | null = null;
  let attachment: string | null = null;
  let stream: string | null = null;
  let profileBad = false;
  const embedded: PDFRef[] = [];
  const af = doc.catalog.lookup(N("AF"));
  const listed = new Set(af instanceof PDFArray ? af.asArray() : []);
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const s = dict.lookup(N("S"));
    if (s instanceof PDFName && (dict.has(N("JS")) || ["Launch", "JavaScript", "SubmitForm", "ResetForm", "ImportData", "Hide", "Sound", "Movie", "Rendition", "SetOCGState", "Trans", "GoTo3DView", "GoToE"].includes(s.decodeText()))) {
      if (!(s.decodeText() === "GoToE" && part === 3)) action ??= s.decodeText() === "JavaScript" ? "A script is left." : "An action PDF/A forbids is left.";
    }
    if (s === N("Named")) {
      const n = dict.lookup(N("N"));
      if (!(n instanceof PDFName) || !["NextPage", "PrevPage", "FirstPage", "LastPage"].includes(n.decodeText())) action ??= "A named action PDF/A forbids is left.";
    }
    const aa = dict.lookup(N("AA"));
    if (aa instanceof PDFDict && aa.values().some((a) => (ctx.lookup(a) as PDFDict | undefined)?.lookup?.(N("S")) instanceof PDFName)) action ??= "Additional actions are left.";
    if (dict.has(N("EF"))) {
      if (part === 2) attachment ??= "An attached file is left.";
      else {
        embedded.push(ref);
        const file = (dict.lookup(N("EF")) as PDFDict | undefined)?.lookup(N("F"));
        const sub = file instanceof PDFStream ? file.dict.lookup(N("Subtype")) : undefined;
        if (!dict.has(N("F")) || !dict.has(N("UF")) || !(dict.lookup(N("AFRelationship")) instanceof PDFName)) attachment ??= "An attachment's description is incomplete.";
        else if (!(sub instanceof PDFName) || !/^[-\w+.]+\/[-\w+.]+$/.test(sub.decodeText())) attachment ??= "An attachment has no file type.";
        else if (!listed.has(ref)) attachment ??= "An attachment isn't listed as the document's.";
      }
    }
    if (obj instanceof PDFStream) {
      const f = dict.lookup(N("Filter"));
      const filters = f instanceof PDFName ? [f] : f instanceof PDFArray ? f.asArray().map((x) => ctx.lookup(x)) : [];
      if (filters.some((x) => x instanceof PDFName && BAD_FILTERS.has(x.decodeText()))) stream ??= "A stream is compressed in a way PDF/A forbids.";
      if (dict.has(N("F")) || dict.has(N("FFilter"))) stream ??= "A stream's data is meant to come from another file.";
      const sub = dict.lookup(N("Subtype"));
      if (sub === N("PS")) stream ??= "A PostScript object is left.";
      if (sub === N("Image") && (dict.lookup(N("Interpolate")) === PDFBool.True || dict.has(N("Alternates")) || dict.has(N("OPI")))) stream ??= "A picture has a setting PDF/A forbids.";
      if (sub === N("Form") && (dict.has(N("Ref")) || dict.has(N("PS")))) stream ??= "A reference or PostScript form is left.";
    }
    if (dict.lookup(N("Type")) === N("ExtGState") && (dict.has(N("TR")) || dict.has(N("HTP")) || (dict.has(N("TR2")) && dict.lookup(N("TR2")) !== N("Default")))) stream ??= "A transfer function is left.";
    for (const [, v] of dict.entries()) {
      if (v instanceof PDFArray && v.size() === 2 && v.lookup(0) === N("ICCBased")) {
        const p = v.lookup(1);
        const n = p instanceof PDFStream ? p.dict.lookup(N("N")) : undefined;
        if (!(p instanceof PDFStream) || !goodInputProfile(readProfile(streamBytes(p)), n instanceof PDFNumber ? n.asNumber() : undefined)) profileBad = true;
      }
    }
  }
  const names = doc.catalog.lookup(N("Names"));
  if (names instanceof PDFDict && names.has(N("JavaScript"))) action ??= "A script is left.";
  if (doc.catalog.has(N("AA")) || doc.getPages().some((p) => p.node.has(N("AA")))) action ??= "Additional actions are left.";
  if (names instanceof PDFDict && part === 2 && names.has(N("EmbeddedFiles"))) attachment ??= "An attached file is left.";
  if (profileBad) colour ??= "A colour profile isn't one PDF/A accepts.";

  // Content: fonts and what the pages draw.
  const content = readContent(doc);
  const intent = intents instanceof PDFArray ? (intents.lookup(0) as PDFDict | undefined)?.lookup(N("DestOutputProfile")) : undefined;
  const space = intent instanceof PDFStream ? readProfile(streamBytes(intent))?.space : undefined;
  const uncovered = [...content.resources].some((r) => {
    const cs = r.lookup(N("ColorSpace"));
    const has = (k: string) => cs instanceof PDFDict && cs.has(N(k));
    return (space === "RGB " && content.deviceCmyk && !has("DefaultCMYK")) || (space === "CMYK" && content.deviceRgb && !has("DefaultRGB"));
  });
  if (uncovered) colour ??= "Some colours aren't covered by the output intent.";
  add("colour", colour);

  const fontPages = new Set<number>();
  let fontProblem: string | null = null;
  for (const use of content.fonts.values()) {
    const embeddedOk = isEmbedded(use.dict);
    const sub = use.dict.lookup(N("Subtype"));
    if (!embeddedOk && (use.shown.size || (!use.composite && !isStandard14(use.dict) && !(use.dict.lookup(N("Widths")) instanceof PDFArray)))) {
      fontProblem ??= "A font isn't embedded.";
      use.pages.forEach((p) => fontPages.add(p + 1));
      continue;
    }
    if (sub === N("TrueType") && embeddedOk && use.shown.size) {
      // Widths in the font and in the PDF agree (checked for symbolic TrueType fonts, such as the substitutes).
      const fd = descriptorOf(use.dict);
      const ff = fd?.lookup(N("FontFile2"));
      const flags = fd?.lookup(N("Flags"));
      const symbolic = flags instanceof PDFNumber && !!(flags.asNumber() & 4) && !use.dict.has(N("Encoding"));
      const program = ff instanceof PDFStream && symbolic ? TrueTypeFont.from(streamBytes(ff) ?? new Uint8Array()) : null;
      if (program) {
        const widths = use.dict.lookup(N("Widths"));
        const first = (use.dict.lookup(N("FirstChar")) as PDFNumber | undefined)?.asNumber() ?? 0;
        for (const code of use.shown) {
          const gid = program.symbolGlyph(code);
          const w = widths instanceof PDFArray ? widths.lookup(code - first) : undefined;
          if (!gid) fontProblem ??= "A font lacks a letter it draws.";
          else if (w instanceof PDFNumber && Math.abs((program.advance(gid) * 1000) / program.unitsPerEm - w.asNumber()) > 1) fontProblem ??= "A font's widths don't match its letters.";
          else continue;
          use.pages.forEach((p) => fontPages.add(p + 1));
          break;
        }
      }
    }
  }
  add("fonts", fontProblem, [...fontPages].sort((a, b) => a - b));
  add("actions", action);
  if (part === 3 || attachment) add("attachments", attachment);

  // Comments and links.
  let annot: string | null = null;
  const annotPages = new Set<number>();
  let widgets = false;
  doc.getPages().forEach((page, p) => {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const kind = (a.lookup(N("Subtype")) as PDFName | undefined)?.decodeText() ?? "";
      const f = a.lookup(N("F"));
      const flags = f instanceof PDFNumber ? f.asNumber() : null;
      const ap = a.lookup(N("AP"));
      const r = a.lookup(N("Rect"));
      const rect = r instanceof PDFArray ? r.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0)) : [];
      const empty = rect.length === 4 && rect[0] === rect[2] && rect[1] === rect[3];
      let bad: string | null = null;
      if (!ANNOTS.has(kind) || (kind === "FileAttachment" && part === 2)) bad = "A comment of a kind PDF/A forbids is left.";
      else if (kind !== "Popup" && flags === null) bad = "A comment has no flags.";
      else if (flags !== null && ((flags & 4) === 0 || flags & (1 | 2 | 32 | 256))) bad = "A comment isn't set to print, or is hidden.";
      else if (!(ap instanceof PDFDict) && !empty && kind !== "Popup" && kind !== "Link") bad = "A comment has no appearance.";
      else if (ap instanceof PDFDict && (ap.keys().length !== 1 || !ap.has(N("N")))) bad = "A comment has appearances other than its normal one.";
      else if (ap instanceof PDFDict && kind !== "Widget" && !(ap.lookup(N("N")) instanceof PDFStream)) bad = "A comment's appearance isn't a single picture.";
      if (kind === "Widget") widgets = true;
      if (bad) {
        annot ??= bad;
        annotPages.add(p + 1);
      }
    }
  });
  add("annotations", annot, [...annotPages]);

  const form = doc.catalog.lookup(N("AcroForm"));
  add(
    "forms",
    form instanceof PDFDict && (form.has(N("XFA")) || form.lookup(N("NeedAppearances")) === PDFBool.True)
      ? "The form still needs the reader to draw it."
      : doc.catalog.has(N("NeedsRendering"))
        ? "The document still needs the reader to lay it out."
        : widgets && !(form instanceof PDFDict)
          ? null
          : null
  );

  const contentPages = [...content.problems.keys()].map((p) => p + 1);
  const boxes = doc.getPages().flatMap((page, p) => {
    const { width, height } = page.getMediaBox();
    return Math.abs(width) < 3 || Math.abs(height) < 3 || Math.abs(width) > 14400 || Math.abs(height) > 14400 ? [p + 1] : [];
  });
  add(
    "content",
    stream ??
      (content.cuts.size
        ? "A page uses an operator PDF doesn't define."
        : contentPages.length
          ? "A page's content can't be read with confidence."
          : content.orphans.size
            ? "Some content uses resources it doesn't name."
            : boxes.length
              ? "A page is smaller or larger than PDF/A allows."
              : null),
    [...contentPages, ...boxes]
  );
  return out;
}
