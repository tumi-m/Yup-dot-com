import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  TextRenderingMode,
  beginMarkedContent,
  beginText,
  concatTransformationMatrix,
  endMarkedContent,
  endText,
  fill,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setCharacterSpacing,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
  type PDFDocument,
  type PDFFont,
  type PDFObject,
  type PDFOperator,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readOperators, type Token } from "../compress/lexer";
import { decodeFully } from "../compress/streams";
import { FontBook, vendorFonts, type Face, type FontFiles } from "../text-to-pdf/fonts";
import { fontLabel, standardFont } from "./fonts";
import { COVER_TAG, type CoverReason, type EditableRun, type Matrix, type RemovePlan } from "./types";

/**
 * Writes Edit text's changes into a PDF. Where a run's words are drawn by
 * operations of the page's own content that draw nothing else, those
 * operations are taken out (the space they took is kept, so the rest of the
 * line stays where it was) and the new words are drawn in their place.
 * Where that can't be shown to be safe, the old words are covered with a box
 * in the colour round them and the new words drawn over it; the report says
 * which, so people can be told.
 */

/** One changed run. The editor's edits carry more; this is what the file needs. */
export interface TextEdit {
  /** 0-indexed. */
  page: number;
  run: EditableRun;
  /** The new words; empty takes the run away. */
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  /** The page's colour round the old words, for covering them. */
  background: string;
}

export interface TextEditReport {
  /** Runs whose old words were taken out of the file. */
  removed: number;
  /** Runs whose old words are covered, not removed: page (1-based) and why. */
  covered: { page: number; reason: CoverReason | "page" }[];
  /** Where new words are in another font than the old ones. */
  fonts: { page: number; from: string; to: string }[];
  /** Letters no font here could draw, left out. */
  missing: string[];
}

/** An edit that changes nothing: the run is left as it is. */
export function unchanged(e: TextEdit): boolean {
  const r = e.run;
  return (
    e.text === r.text &&
    Math.abs(e.fontSize - r.size) < 0.01 &&
    e.color.toLowerCase() === r.color.toLowerCase() &&
    e.bold === r.font.bold &&
    e.italic === r.font.italic
  );
}

// --- Reading the page's own content -------------------------------------------------

interface Show {
  op: string;
  start: number;
  end: number;
  operands: Token[];
  /** The font resource it is drawn in, or null when that isn't known. */
  font: string | null;
  /** Its strings' bytes, in order. */
  strings: Uint8Array[];
  /** A later operation in the same text object draws on from where this one stopped. */
  carried: boolean;
  /** The marked content it is in (BDC operators with their property lists), outermost first. */
  marks: Marked[];
}

/** A BDC operator: its tag and property list as written, and where it is. */
interface Marked {
  start: number;
  end: number;
  tag: Token;
  props: Token;
}

interface Content {
  data: Uint8Array;
  shows: Show[];
  /** Every BDC operator, for telling whether a named property list is used by anything else. */
  marked: Marked[];
  /** Graphics state saves less restores: the lowest it went, and where it ended. */
  low: number;
  depth: number;
}

const Contents = PDFName.of("Contents");
const Resources = PDFName.of("Resources");

/** The references to a page's content streams. */
function contentRefs(page: PDFPage): PDFRef[] {
  const raw = page.node.get(Contents);
  if (raw instanceof PDFRef) {
    const list = page.doc.context.lookup(raw);
    return list instanceof PDFArray ? [raw, ...list.asArray().filter((r): r is PDFRef => r instanceof PDFRef)] : [raw];
  }
  return raw instanceof PDFArray ? raw.asArray().filter((r): r is PDFRef => r instanceof PDFRef) : [];
}

/** The page's content streams read as one, or null when some of it can't be read whole. */
function contentBytes(page: PDFPage): Uint8Array | null {
  const { context } = page.doc;
  const raw = page.node.get(Contents);
  if (raw === undefined) return new Uint8Array(0);
  const list = context.lookup(raw);
  const streams = list instanceof PDFArray ? list.asArray().map((r) => context.lookup(r)) : [list];
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    if (!(s instanceof PDFRawStream)) return null;
    // Never a partial read: what isn't read would be lost when it is written back.
    const bytes = decodeFully(context, s, false);
    if (!bytes) return null;
    parts.push(bytes);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length + 1, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    out[at + p.length] = 10;
    at += p.length + 1;
  }
  return out;
}

const SHOWS = new Set(["Tj", "TJ", "'", '"']);
/** Operations after a show that start the next text from the line, not from where it stopped. */
const FROM_LINE = new Set(["Td", "TD", "Tm", "T*", "'", '"', "ET", "BT"]);

function readContent(page: PDFPage): Content | null {
  const data = contentBytes(page);
  if (!data) return null;
  const extG = lookupDict(page, "ExtGState");
  const shows: Show[] = [];
  let font: string | null = null;
  const fonts: (string | null)[] = [];
  let depth = 0;
  let low = 0;
  let last: Show | null = null;
  /** Marked content open: a BDC's property list, or null for BMC. */
  const marked: (Marked | null)[] = [];
  const all: Marked[] = [];
  const whole = readOperators(data, (op, operands, start, end) => {
    if (op === "BDC") {
      const m = operands.length >= 2 ? { start, end, tag: operands[0], props: operands[1] } : null;
      marked.push(m);
      if (m) all.push(m);
    }
    else if (op === "BMC") marked.push(null);
    else if (op === "EMC") marked.pop();
    if (op === "q") {
      fonts.push(font);
      depth++;
    } else if (op === "Q") {
      font = fonts.length ? fonts.pop()! : font;
      depth--;
      low = Math.min(low, depth);
    } else if (op === "Tf") {
      font = operands[0]?.kind === "name" ? (operands[0].value as string) : null;
    } else if (op === "gs") {
      // A graphics state can set the font too; which one isn't followed here.
      const g = operands[0]?.kind === "name" ? extG?.lookup(PDFName.of(operands[0].value as string)) : undefined;
      if (g instanceof PDFDict && g.has(PDFName.of("Font"))) font = null;
    }
    if (SHOWS.has(op)) {
      if (last && (op === "Tj" || op === "TJ")) last.carried = true;
      const strings: Uint8Array[] = [];
      const arg = op === '"' ? operands[2] : operands[0];
      if (arg?.kind === "string") strings.push(arg.bytes!);
      else if (arg?.kind === "array") for (const t of arg.items ?? []) if (t.kind === "string") strings.push(t.bytes!);
      const show: Show = { op, start, end, operands, font, strings, carried: false, marks: marked.filter((m): m is Marked => !!m) };
      shows.push(show);
      last = show;
    } else if (FROM_LINE.has(op)) last = null;
  });
  return whole ? { data, shows, marked: all, low, depth } : null;
}

/** Whether `bytes` are exactly the codes `codes`, each one to four bytes long. */
function encodes(bytes: Uint8Array, codes: number[]): boolean {
  if (bytes.length === codes.length) return codes.every((c, i) => bytes[i] === c);
  if (bytes.length === codes.length * 2) return codes.every((c, i) => bytes[2 * i] * 256 + bytes[2 * i + 1] === c);
  // Codes of mixed lengths (some CJK encodings): try each length in turn.
  const seen = new Set<number>();
  const fit = (at: number, k: number): boolean => {
    if (k === codes.length) return at === bytes.length;
    if (seen.has(at * 65536 + k)) return false;
    seen.add(at * 65536 + k);
    let v = 0;
    for (let n = 1; n <= 4 && at + n <= bytes.length; n++) {
      v = v * 256 + bytes[at + n - 1];
      if (v === codes[k] && fit(at + n, k + 1)) return true;
    }
    return false;
  };
  return fit(0, 0);
}

/** The page's operations the plan names, when the file is still as the plan was made from. */
function planned(content: Content | null, plan: RemovePlan): Show[] | null {
  if (!content || content.shows.length !== plan.total) return null;
  const out: Show[] = [];
  for (const op of plan.ops) {
    const show = content.shows[op.index];
    if (!show) return null;
    const bytes = show.strings.length === 1 ? show.strings[0] : concat(show.strings);
    if (!encodes(bytes, op.codes)) return null;
    out.push(show);
  }
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const num = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(Math.round(v * 10000) / 10000));

/** What an operation becomes once its letters are gone: it still moves the text as far, when later text relies on that. */
function replacement(show: Show, plan: RemovePlan["ops"][number], data: Uint8Array): string {
  const move = show.carried && plan.size > 0 && Math.abs(plan.advance) > 1e-6 ? ` [${num((-plan.advance * 1000) / plan.size)}] TJ` : "";
  const raw = (t: Token) => String.fromCharCode(...data.subarray(t.start, t.end));
  if (show.op === "'") return ` T*${move} `;
  if (show.op === '"') return ` ${raw(show.operands[0])} Tw ${raw(show.operands[1])} Tc T*${move} `;
  return move ? `${move} ` : " ";
}

/** The page's content with the given operations replaced, inside enough q/Q that nothing it sets leaks out. */
function rewrite(content: Content, cuts: { start: number; end: number; text: string }[]): Uint8Array {
  cuts.sort((a, b) => a.start - b.start);
  const opens = 1 + Math.max(0, -content.low);
  const closes = opens + content.depth;
  const head = new TextEncoder().encode("q\n".repeat(opens));
  const tail = new TextEncoder().encode("\n" + "Q\n".repeat(Math.max(1, closes)));
  const parts: Uint8Array[] = [head];
  let at = 0;
  for (const cut of cuts) {
    if (cut.start < at) continue;
    parts.push(content.data.subarray(at, cut.start), latin1(cut.text));
    at = cut.end;
  }
  parts.push(content.data.subarray(at), tail);
  return concat(parts);
}

/** Keys of a property list or structure element that repeat its words for readers and search. */
const ALT_KEYS = ["ActualText", "Alt", "E"].map((k) => PDFName.of(k));
const raw = (data: Uint8Array, t: Token) => String.fromCharCode(...data.subarray(t.start, t.end));

/**
 * Taken-out words can live on as alternate text: ActualText, Alt or E in the
 * marked content round them, inline or named in the page's Properties, or
 * on the structure elements that point at it. They go too. An inline
 * property list is written again without them. A named one only removed
 * text uses loses them; one that text left on the page shares stays as it
 * is (its alternate text is that text's too), and the removed text gets a
 * copy without them under a new name. Returns the cuts for the BDC
 * operators and the marked-content ids they carried.
 */
function dropAltText(page: PDFPage, data: Uint8Array, marks: Marked[], every: Marked[]): { cuts: { start: number; end: number; text: string }[]; mcids: number[] } {
  const cuts: { start: number; end: number; text: string }[] = [];
  const mcids: number[] = [];
  const { context } = page.doc;
  for (const m of marks) {
    if (m.props.kind === "dict") {
      const items = m.props.items ?? [];
      const kept: string[] = [];
      let drop = false;
      for (let i = 0; i + 1 < items.length; i += 2) {
        const key = items[i].kind === "name" ? (items[i].value as string) : "";
        if (key === "MCID" && items[i + 1].kind === "number") mcids.push(items[i + 1].value as number);
        if (ALT_KEYS.some((k) => k.decodeText() === key)) drop = true;
        else kept.push(`${raw(data, items[i])} ${raw(data, items[i + 1])}`);
      }
      if (drop) cuts.push({ start: m.start, end: m.end, text: `${raw(data, m.tag)} <<${kept.join(" ")}>> BDC` });
    } else if (m.props.kind === "name") {
      const named = lookupDict(page, "Properties")?.lookup(PDFName.of(m.props.value as string));
      if (!(named instanceof PDFDict)) continue;
      const mcid = named.lookup(PDFName.of("MCID"));
      if (mcid instanceof PDFNumber) mcids.push(mcid.asNumber());
      if (!ALT_KEYS.some((k) => named.has(k))) continue;
      const name = m.props.value as string;
      const shared = every.some((o) => !marks.includes(o) && o.props.kind === "name" && o.props.value === name);
      if (!shared) {
        for (const k of ALT_KEYS) named.delete(k);
        continue;
      }
      const copy = context.obj({});
      for (const [k, v] of named.entries()) if (!ALT_KEYS.includes(k)) copy.set(k, v);
      const resources = page.node.Resources() ?? context.obj({});
      if (!page.node.Resources()) page.node.set(Resources, resources);
      let props = resources.lookup(PDFName.of("Properties"));
      if (!(props instanceof PDFDict)) resources.set(PDFName.of("Properties"), (props = context.obj({})));
      const key = (props as PDFDict).uniqueKey("Props");
      (props as PDFDict).set(key, context.register(copy));
      cuts.push({ start: m.start, end: m.end, text: `${raw(data, m.tag)} ${key.toString()} BDC` });
    }
  }
  return { cuts, mcids };
}

/** Takes ActualText, Alt and E off the structure elements that hold the given marked content of a page. */
function dropStructAlt(page: PDFPage, mcids: Set<number>) {
  const { context } = page.doc;
  const root = page.doc.catalog.lookup(PDFName.of("StructTreeRoot"));
  if (!(root instanceof PDFDict) || !mcids.size) return;
  const seen = new Set<PDFDict>();
  let budget = 200_000;
  const visit = (node: PDFObject | undefined, pg: PDFObject | undefined) => {
    const obj = node instanceof PDFRef ? context.lookup(node) : node;
    if (obj instanceof PDFArray) return obj.asArray().forEach((n) => visit(n, pg));
    if (!(obj instanceof PDFDict) || seen.has(obj) || --budget < 0) return;
    seen.add(obj);
    const own = obj.get(PDFName.of("Pg")) ?? pg;
    const k = obj.get(PDFName.of("K"));
    const kids = k === undefined ? [] : context.lookup(k) instanceof PDFArray ? (context.lookup(k) as PDFArray).asArray() : [k];
    const holds = kids.some((kid) => {
      const v = kid instanceof PDFRef ? context.lookup(kid) : kid;
      if (v instanceof PDFNumber) return own === page.ref && mcids.has(v.asNumber());
      if (v instanceof PDFDict && v.get(PDFName.of("MCID")) instanceof PDFNumber) {
        return (v.get(PDFName.of("Pg")) ?? own) === page.ref && mcids.has((v.get(PDFName.of("MCID")) as PDFNumber).asNumber());
      }
      return false;
    });
    if (holds) for (const key of ALT_KEYS) obj.delete(key);
    for (const kid of kids) visit(kid, own);
  };
  visit(root.get(PDFName.of("K")), undefined);
}

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function lookupDict(page: PDFPage, category: string): PDFDict | undefined {
  const res = page.node.context.lookup(page.node.getInheritableAttribute(Resources));
  const dict = res instanceof PDFDict ? res.lookup(PDFName.of(category)) : undefined;
  return dict instanceof PDFDict ? dict : undefined;
}

// --- Fonts ---------------------------------------------------------------------------

const STANDARD: Record<string, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  "Helvetica-Bold": StandardFonts.HelveticaBold,
  "Helvetica-Oblique": StandardFonts.HelveticaOblique,
  "Helvetica-BoldOblique": StandardFonts.HelveticaBoldOblique,
  "Times-Roman": StandardFonts.TimesRoman,
  "Times-Bold": StandardFonts.TimesRomanBold,
  "Times-Italic": StandardFonts.TimesRomanItalic,
  "Times-BoldItalic": StandardFonts.TimesRomanBoldItalic,
  Courier: StandardFonts.Courier,
  "Courier-Bold": StandardFonts.CourierBold,
  "Courier-Oblique": StandardFonts.CourierOblique,
  "Courier-BoldOblique": StandardFonts.CourierBoldOblique,
};

const NO_LIGATURES = { liga: false, clig: false, dlig: false, calt: false };

/** The font program the file carries for a font dictionary: TrueType or OpenType only. */
function program(doc: PDFDocument, dict: PDFDict): Uint8Array | null {
  const { context } = doc;
  let target = dict;
  if (dict.lookup(PDFName.of("Subtype")) === PDFName.of("Type0")) {
    const kids = dict.lookup(PDFName.of("DescendantFonts"));
    const kid = kids instanceof PDFArray ? kids.lookup(0) : undefined;
    if (!(kid instanceof PDFDict)) return null;
    target = kid;
  }
  const fd = target.lookup(PDFName.of("FontDescriptor"));
  if (!(fd instanceof PDFDict)) return null;
  const tt = fd.lookup(PDFName.of("FontFile2"));
  const ff3 = fd.lookup(PDFName.of("FontFile3"));
  const file = tt instanceof PDFRawStream ? tt : ff3 instanceof PDFRawStream && ff3.dict.lookup(PDFName.of("Subtype")) === PDFName.of("OpenType") ? ff3 : null;
  return file ? decodeFully(context, file, false) : null;
}

const baseName = (dict: PDFDict) => {
  const n = dict.lookup(PDFName.of("BaseFont"));
  return n instanceof PDFName ? n.decodeText() : "";
};

/** The page's font dictionary a run is drawn in: by the resource the operations name, or by its name. */
function fontDictFor(page: PDFPage, resource: string | null, run: EditableRun): PDFDict | null {
  const fonts = lookupDict(page, "Font");
  if (!fonts) return null;
  if (resource) {
    const d = fonts.lookup(PDFName.of(resource));
    if (d instanceof PDFDict) return d;
  }
  for (const [, ref] of fonts.entries()) {
    const d = page.node.context.lookup(ref);
    if (d instanceof PDFDict && run.font.name && baseName(d) === run.font.name) return d;
  }
  return null;
}

/** A piece of the new words in one font; null font for letters none can draw. */
interface Piece {
  text: string;
  font: PDFFont;
}

class Fonts {
  private standard = new Map<string, PDFFont>();
  private own = new Map<PDFDict, Promise<{ font: PDFFont; has: (cp: number) => boolean } | null>>();
  book: FontBook;
  missing = new Set<string>();

  constructor(private doc: PDFDocument, files: FontFiles) {
    doc.registerFontkit(fontkit);
    this.book = new FontBook(doc, files);
  }

  async standardFont(name: string): Promise<PDFFont> {
    let f = this.standard.get(name);
    if (!f) this.standard.set(name, (f = await this.doc.embedFont(STANDARD[name])));
    return f;
  }

  /** The run's own font, when it is whole and has every letter of `text`. */
  async ownFont(dict: PDFDict | null, run: EditableRun, text: string): Promise<PDFFont | null> {
    if (!dict || run.font.subset || run.font.type3 || /^[A-Z]{6}\+/.test(baseName(dict))) return null;
    let entry = this.own.get(dict);
    if (!entry) {
      entry = (async () => {
        const bytes = program(this.doc, dict);
        if (!bytes) return null;
        try {
          const parsed = fontkit.create(bytes) as unknown as { hasGlyphForCodePoint(cp: number): boolean; characterSet: number[] };
          if (!parsed.characterSet?.length) return null;
          const font = await this.doc.embedFont(bytes, { subset: true, features: NO_LIGATURES });
          return { font, has: (cp: number) => parsed.hasGlyphForCodePoint(cp) };
        } catch {
          return null;
        }
      })();
      this.own.set(dict, entry);
    }
    const got = await entry;
    if (!got) return null;
    for (const ch of text) if (!got.has(ch.codePointAt(0)!)) return null;
    return got.font;
  }
}

const faceOf = (family: string, bold: boolean, italic: boolean): Face =>
  family === "mono" ? (bold ? "monoBold" : "mono") : bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";

/** Splits `text` between the standard font and Noto Sans, noting what Noto Sans must bring. */
function split(text: string, font: PDFFont): { text: string; standard: boolean }[] {
  const out: { text: string; standard: boolean }[] = [];
  for (const ch of text) {
    let ok = true;
    try {
      font.encodeText(ch);
    } catch {
      ok = false;
    }
    const last = out[out.length - 1];
    if (last && last.standard === ok) last.text += ch;
    else out.push({ text: ch, standard: ok });
  }
  return out;
}

// --- Drawing ----------------------------------------------------------------------------

function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const v = m ? parseInt(m[1], 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const cm = (m: Matrix) => concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]);

/** A box over the old words, in the colour round them, tagged so a later read leaves what it hides alone. */
function coverOps(e: TextEdit): PDFOperator[] {
  const r = e.run;
  const s = r.size;
  const padX = s * 0.04;
  const padY = s * 0.06;
  const [red, green, blue] = rgbOf(e.background);
  return [
    beginMarkedContent(COVER_TAG),
    pushGraphicsState(),
    cm(r.user),
    setFillingRgbColor(red, green, blue),
    rectangle(r.x0 - padX, r.descent * s - padY, r.x1 - r.x0 + 2 * padX, (r.ascent - r.descent) * s + 2 * padY),
    fill(),
    popGraphicsState(),
    endMarkedContent(),
  ];
}

function textOps(page: PDFPage, e: TextEdit, pieces: Piece[], keys: Map<PDFFont, PDFName>): PDFOperator[] {
  const [red, green, blue] = rgbOf(e.color);
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    cm(e.run.user),
    beginText(),
    setTextRenderingMode(TextRenderingMode.Fill),
    setCharacterSpacing(0),
    setWordSpacing(0),
    setCharacterSqueeze(100),
    setTextRise(0),
    setFillingRgbColor(red, green, blue),
  ];
  let last = 0;
  let x = 0;
  for (const p of pieces) {
    let key = keys.get(p.font);
    if (!key) keys.set(p.font, (key = page.node.newFontDictionary(p.font.name, p.font.ref)));
    if (x !== last) ops.push(moveText(x - last, 0));
    last = x;
    ops.push(setFontAndSize(key, e.fontSize), showText(p.font.encodeText(p.text)));
    x += p.font.widthOfTextAtSize(p.text, e.fontSize);
  }
  ops.push(endText(), popGraphicsState());
  return ops;
}

/** Applies the edits to `doc` (the pdf-lib document being written) and says what was done. */
export async function applyTextEdits(doc: PDFDocument, edits: TextEdit[], opts: { fonts?: FontFiles } = {}): Promise<TextEditReport> {
  const report: TextEditReport = { removed: 0, covered: [], fonts: [], missing: [] };
  const pages = doc.getPages();
  const byPage = new Map<number, TextEdit[]>();
  for (const e of edits) {
    if (!pages[e.page] || unchanged(e)) continue;
    byPage.set(e.page, [...(byPage.get(e.page) ?? []), e]);
  }
  if (!byPage.size) return report;
  const fonts = new Fonts(doc, opts.fonts ?? vendorFonts);

  // First every page's plan and fonts, so Noto Sans is fetched once for all of them.
  const work: { page: PDFPage; index: number; content: Content | null; cuts: { start: number; end: number; text: string }[]; items: { e: TextEdit; covered: boolean; font: PDFFont; face: Face | null; own: boolean }[] }[] = [];
  for (const [index, list] of byPage) {
    const page = pages[index];
    const needed = list.some((e) => e.run.remove);
    const content = needed ? readContent(page) : null;
    const cuts: { start: number; end: number; text: string }[] = [];
    const items: (typeof work)[number]["items"] = [];
    const marks = new Map<number, Marked>();
    for (const e of list) {
      const shows = e.run.remove ? planned(content, e.run.remove) : null;
      if (shows && content) {
        e.run.remove!.ops.forEach((op, i) => cuts.push({ start: shows[i].start, end: shows[i].end, text: replacement(shows[i], op, content.data) }));
        for (const show of shows) for (const m of show.marks) marks.set(m.start, m);
        report.removed++;
      } else report.covered.push({ page: index + 1, reason: e.run.remove ? "page" : e.run.cover ?? "unmatched" });
      const dict = fontDictFor(page, shows?.[0]?.font ?? null, e.run);
      const sameStyle = e.bold === e.run.font.bold && e.italic === e.run.font.italic;
      const own = sameStyle && e.text.trim() ? await fonts.ownFont(dict, e.run, e.text) : null;
      const std = await fonts.standardFont(standardFont(e.run.font.family, e.bold, e.italic));
      const face = own ? null : faceOf(e.run.font.family, e.bold, e.italic);
      if (face) for (const part of split(e.text, std)) if (!part.standard) fonts.book.need(part.text, face);
      items.push({ e, covered: !shows, font: own ?? std, face, own: !!own });
    }
    if (content && marks.size) {
      const alt = dropAltText(page, content.data, [...marks.values()], content.marked);
      cuts.push(...alt.cuts);
      dropStructAlt(page, new Set(alt.mcids));
    }
    work.push({ page, index, content, cuts, items });
  }
  await fonts.book.ready();

  for (const { page, index, content, cuts, items } of work) {
    const ops: PDFOperator[] = [];
    const keys = new Map<PDFFont, PDFName>();
    if (cuts.length && content) {
      const before = contentRefs(page);
      const stream = doc.context.flateStream(rewrite(content, cuts));
      page.node.set(Contents, doc.context.obj([doc.context.register(stream)]));
      // The old streams still hold the old words: they leave the file unless another page draws them too.
      // pdf-lib's own q and Q streams, which it wraps other pages in later.
      const { pushGraphicsStateContentStreamRef: q, popGraphicsStateContentStreamRef: Q } = doc.context as unknown as Record<string, PDFRef | undefined>;
      const shared = new Set([...pages.filter((p) => p !== page).flatMap(contentRefs), q, Q].map(String));
      for (const ref of before) if (!shared.has(String(ref))) doc.context.delete(ref);
    }
    for (const { e, covered, font, face, own } of items) {
      if (covered) ops.push(...coverOps(e));
      if (!e.text.trim()) continue;
      const pieces: Piece[] = [];
      for (const part of face ? split(e.text, font) : [{ text: e.text, standard: true }]) {
        if (part.standard) {
          pieces.push({ text: part.text, font });
          continue;
        }
        for (const run of fonts.book.runs(part.text, face!)) {
          if (run.font?.font) pieces.push({ text: run.text, font: run.font.font });
          else for (const ch of run.text) if (!/\s/.test(ch)) fonts.missing.add(ch);
        }
      }
      if (!pieces.length) continue;
      ops.push(...textOps(page, e, pieces, keys));
      const from = fontLabel(e.run.font.name);
      const noto = pieces.some((p) => p.font !== font);
      const to = own ? from : pieces.some((p) => p.font === font) ? fontLabel(font.name) + (noto ? " and Noto Sans" : "") : "Noto Sans";
      if (to !== from && !report.fonts.some((f) => f.page === index + 1 && f.from === from && f.to === to)) report.fonts.push({ page: index + 1, from, to });
    }
    if (ops.length) {
      const stream = doc.context.contentStream(ops);
      page.node.addContentStream(doc.context.register(stream));
    }
  }
  report.missing = [...fonts.missing];
  return report;
}
