/**
 * Reads every content stream a page draws with (its own, its form XObjects,
 * its annotations' appearances, Type 3 glyphs, tiling patterns and soft
 * masks) the way PDF/A asks about them: which fonts draw which character
 * codes, visibly or only invisibly (text rendering mode 3); operators PDF
 * doesn't define, which are cut out; inline images and q/Q nesting PDF/A
 * forbids; and streams that use resources without having their own.
 *
 * Pure pdf-lib and the content-stream lexer, so it runs in a worker and in
 * Node tests. It reads; prepare.ts and fonts.ts make the changes.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFStream, type PDFDocument, type PDFObject } from "pdf-lib";
import { OPERATORS, readOperators, type InlineImageEntries, type Token } from "../compress/lexer";
import { decodeFully } from "../compress/streams";

const N = PDFName.of;

/** How one font is used. */
export interface FontUse {
  dict: PDFDict;
  /** Codes drawn with a visible rendering mode (one byte each; composite fonts only note that they draw). */
  shown: Set<number>;
  /** Codes drawn only with rendering mode 3 (invisible, as OCR text is). */
  hidden: Set<number>;
  /** Pages (0-based) that draw with it. */
  pages: Set<number>;
  /** A composite (Type 0) font: two-byte codes, not substituted here. */
  composite: boolean;
}

/** Why a page can only be made PDF/A as a picture of itself. */
export type PageProblem = "content" | "nesting" | "inline-image";

export interface ContentFacts {
  fonts: Map<PDFDict, FontUse>;
  /** Pages whose content PDF/A can't accept and can't be fixed in place. */
  problems: Map<number, PageProblem>;
  /** Every resource dictionary a page draws with. */
  resources: Set<PDFDict>;
  /** Content streams that use resources they don't have, and the ones they were drawn with. */
  orphans: Map<PDFStream, PDFDict>;
  /** Operators to cut out: per stream (or per page, for its own content), [start, end) in the decoded bytes. */
  cuts: Map<PDFStream | number, [number, number][]>;
  /** Some content draws with DeviceCMYK or DeviceRGB by its operators (k, K, rg, RG) or an inline image. */
  deviceCmyk: boolean;
  deviceRgb: boolean;
  /** Image XObjects drawn, and the pages that draw each. */
  images: Map<PDFStream, Set<number>>;
}

/** Bytes of a stream as readers see them, whatever kind of pdf-lib stream it is. */
export function streamBytes(stream: PDFStream): Uint8Array | null {
  if (stream instanceof PDFRawStream) return decodeFully(stream.dict.context, stream, true);
  const own = stream as unknown as { getUnencodedContents?: () => Uint8Array };
  return own.getUnencodedContents ? own.getUnencodedContents() : stream.getContents();
}

/** A page's own content: its streams joined as readers join them, and whether all of them could be read. */
export function pageContent(doc: PDFDocument, pageIndex: number): { bytes: Uint8Array; ok: boolean } {
  const node = doc.getPage(pageIndex).node;
  const contents = node.Contents();
  const streams: PDFStream[] = [];
  if (contents instanceof PDFStream) streams.push(contents);
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFStream) streams.push(s);
    }
  }
  const parts: Uint8Array[] = [];
  let ok = true;
  for (const s of streams) {
    const b = streamBytes(s);
    if (b) parts.push(b);
    else ok = false;
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    bytes[at + p.length] = 10; // a stream may end mid-token: keep them apart
    at += p.length + 1;
  }
  return { bytes, ok };
}

const lookupDict = (dict: PDFDict | undefined, key: string): PDFDict | undefined => {
  const v = dict?.lookup(N(key));
  return v instanceof PDFDict ? v : undefined;
};

/** Operators whose name operand is a resource of the stream. */
const NAMED: Record<string, string> = { Tf: "Font", Do: "XObject", gs: "ExtGState", sh: "Shading", BDC: "Properties", DP: "Properties" };
const DEVICE_SPACES = new Set(["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern"]);

interface State {
  font: PDFDict | undefined;
  mode: number;
}

const INTENTS = new Set(["RelativeColorimetric", "AbsoluteColorimetric", "Perceptual", "Saturation"]);

const INLINE_FILTERS = new Set(["ASCIIHexDecode", "ASCII85Decode", "FlateDecode", "RunLengthDecode", "CCITTFaxDecode", "DCTDecode", "AHx", "A85", "Fl", "RL", "CCF", "DCT"]);

/** What a stream drew with, directly or in what it drew: given again to each page that draws it. */
interface Touched {
  fonts: Set<FontUse>;
  problems: Set<PageProblem>;
  images: Set<PDFStream>;
}

/** Reads every page's content (see the top of the file). */
export function readContent(doc: PDFDocument): ContentFacts {
  const facts: ContentFacts = {
    fonts: new Map(),
    problems: new Map(),
    resources: new Set(),
    orphans: new Map(),
    cuts: new Map(),
    deviceCmyk: false,
    deviceRgb: false,
    images: new Map(),
  };
  const pages = doc.getPages();
  // A stream already read with this font and mode on entry gives nothing new to read, only to note.
  const cache = new WeakMap<object, Map<string, Touched>>();
  /** The streams being read, innermost last: each notes what is used inside it. */
  const open: Touched[] = [];
  const ids = new WeakMap<PDFDict, number>();
  let nextId = 1;
  const idOf = (d: PDFDict | undefined) => {
    if (!d) return 0;
    let id = ids.get(d);
    if (id === undefined) ids.set(d, (id = nextId++));
    return id;
  };

  const useFont = (font: PDFDict, page: number): FontUse => {
    let use = facts.fonts.get(font);
    if (!use) {
      use = { dict: font, shown: new Set(), hidden: new Set(), pages: new Set(), composite: font.lookup(N("Subtype")) === N("Type0") };
      facts.fonts.set(font, use);
    }
    use.pages.add(page);
    for (const t of open) t.fonts.add(use);
    return use;
  };

  const useImage = (image: PDFStream, page: number) => {
    let set = facts.images.get(image);
    if (!set) facts.images.set(image, (set = new Set()));
    set.add(page);
    for (const t of open) t.images.add(image);
    // Its soft mask is an image too.
    const smask = image.dict.lookup(N("SMask"));
    if (smask instanceof PDFStream && smask !== image) useImage(smask, page);
  };

  const problem = (page: number, why: PageProblem) => {
    if (!facts.problems.has(page)) facts.problems.set(page, why);
    for (const t of open) t.problems.add(why);
  };

  /** Reads `key`'s content once, and on each later page only notes what it used. */
  const once = (key: object, variant: string, page: number, read: () => void) => {
    let byVariant = cache.get(key);
    if (!byVariant) cache.set(key, (byVariant = new Map()));
    const done = byVariant.get(variant);
    if (done) {
      for (const use of done.fonts) {
        use.pages.add(page);
        for (const t of open) t.fonts.add(use);
      }
      for (const why of done.problems) problem(page, why);
      for (const image of done.images) useImage(image, page);
      return;
    }
    const touched: Touched = { fonts: new Set(), problems: new Set(), images: new Set() };
    // Set before reading, so a stream that draws itself stops here.
    byVariant.set(variant, touched);
    open.push(touched);
    try {
      read();
    } finally {
      open.pop();
    }
  };

  /** Walks one content stream. `resources` is what it draws with; `ownResources` says whether that is its own. */
  const walk = (
    bytes: Uint8Array,
    resources: PDFDict | undefined,
    page: number,
    entry: State,
    owner: PDFStream | number,
    depth: number,
    ownResources: boolean
  ) => {
    if (depth > 24) return;
    if (resources) {
      facts.resources.add(resources);
      walkResourceExtras(resources, page, depth);
    }
    let state: State = { ...entry };
    const stack: State[] = [];
    let nesting = 0;
    let usesNames = false;
    const cuts: [number, number][] = [];

    const show = (strings: Uint8Array[]) => {
      if (!state.font) return;
      const use = useFont(state.font, page);
      const into = state.mode === 3 ? use.hidden : use.shown;
      if (use.composite) {
        if (strings.some((s) => s.length)) into.add(-1);
        return;
      }
      for (const s of strings) for (const b of s) into.add(b);
      if (state.font.lookup(N("Subtype")) === N("Type3")) walkType3(state.font, page, depth);
    };
    const stringsOf = (tokens: Token[]) => tokens.filter((t) => t.kind === "string").map((t) => t.bytes!);

    const ok = readOperators(
      bytes,
      (op, operands, start, end) => {
        const nameArg = operands.find((t) => t.kind === "name")?.value as string | undefined;
        if (NAMED[op] && nameArg !== undefined && !(operands[1]?.kind === "dict")) usesNames = true;
        switch (op) {
          case "q":
            stack.push({ ...state });
            nesting++;
            if (nesting > 28) problem(page, "nesting");
            return;
          case "Q":
            state = stack.pop() ?? state;
            nesting = Math.max(0, nesting - 1);
            return;
          case "Tr": {
            const v = operands[0]?.value;
            if (typeof v === "number") state.mode = v;
            return;
          }
          case "Tf":
            state.font = nameArg !== undefined ? lookupDict(lookupDict(resources, "Font"), nameArg) : undefined;
            return;
          case "gs": {
            const gs = nameArg !== undefined ? lookupDict(lookupDict(resources, "ExtGState"), nameArg) : undefined;
            const f = gs?.lookup(N("Font"));
            if (f instanceof PDFArray) {
              const font = f.lookup(0);
              if (font instanceof PDFDict) state.font = font;
            }
            return;
          }
          case "Tj":
          case "'":
          case '"':
            show(stringsOf(operands));
            return;
          case "TJ":
            show(operands.flatMap((t) => (t.kind === "array" ? stringsOf(t.items ?? []) : [])));
            return;
          case "k":
          case "K":
            facts.deviceCmyk = true;
            return;
          case "rg":
          case "RG":
            facts.deviceRgb = true;
            return;
          case "cs":
          case "CS":
            if (nameArg !== undefined && !DEVICE_SPACES.has(nameArg)) usesNames = true;
            if (nameArg === "DeviceCMYK") facts.deviceCmyk = true;
            if (nameArg === "DeviceRGB") facts.deviceRgb = true;
            return;
          case "scn":
          case "SCN":
            if (nameArg !== undefined) usesNames = true;
            return;
          case "ri":
            // A rendering intent PDF doesn't define is only a hint: it goes.
            if (!INTENTS.has(nameArg ?? "")) cuts.push([start, end]);
            return;
          case "Do": {
            const stream = nameArg !== undefined ? lookupStream(lookupDict(resources, "XObject"), nameArg) : undefined;
            if (stream?.dict.lookup(N("Subtype")) === N("Image")) useImage(stream, page);
            else if (stream) walkForm(stream, resources, page, state, depth);
            return;
          }
        }
        if (!OPERATORS.has(op)) cuts.push([start, end]);
      },
      (entries) => inlineImage(entries, page)
    );
    if (!ok) problem(page, "content");
    if (cuts.length) facts.cuts.set(owner, cuts);
    if (usesNames && !ownResources && typeof owner !== "number" && resources) facts.orphans.set(owner, resources);
  };

  const inlineImage = (entries: InlineImageEntries, page: number) => {
    const filter = entries.F ?? entries.Filter;
    const filters = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter];
    if (filters.some((f) => typeof f !== "string" || !INLINE_FILTERS.has(f))) problem(page, "inline-image");
    const interpolate = entries.I ?? entries.Interpolate;
    if (interpolate === "true") problem(page, "inline-image");
    const mask = (entries.IM ?? entries.ImageMask) === "true";
    const bpc = entries.BPC ?? entries.BitsPerComponent;
    if (typeof bpc === "number" && (mask ? bpc !== 1 : ![1, 2, 4, 8, 16].includes(bpc))) problem(page, "inline-image");
    const cs = entries.CS ?? entries.ColorSpace;
    const family = Array.isArray(cs) ? cs[0] : cs;
    if (family === "CMYK" || family === "DeviceCMYK") facts.deviceCmyk = true;
    if (family === "RGB" || family === "DeviceRGB") facts.deviceRgb = true;
  };

  /** A form XObject (also an annotation's appearance, a pattern or a soft mask's group). */
  const walkForm = (stream: PDFStream, inherited: PDFDict | undefined, page: number, state: State, depth: number) => {
    const d = stream.dict;
    if (d.lookup(N("Subtype")) === N("Image") || (d.lookup(N("Subtype")) !== N("Form") && d.lookup(N("BBox")) === undefined)) return;
    once(stream, `${idOf(state.font)}|${state.mode === 3 ? 3 : 0}`, page, () => {
      const bytes = streamBytes(stream);
      if (!bytes) return problem(page, "content");
      const own = lookupDict(d, "Resources");
      walk(bytes, own ?? inherited, page, state, stream, depth + 1, !!own);
    });
  };

  const walkType3 = (font: PDFDict, page: number, depth: number) => {
    once(font, "", page, () => {
      const procs = lookupDict(font, "CharProcs");
      const own = lookupDict(font, "Resources");
      for (const [, value] of procs?.entries() ?? []) {
        const glyph = font.context.lookup(value);
        if (!(glyph instanceof PDFStream)) continue;
        const bytes = streamBytes(glyph);
        if (!bytes) {
          problem(page, "content");
          continue;
        }
        walk(bytes, own, page, { font: undefined, mode: 0 }, glyph, depth + 1, true);
      }
    });
  };

  /** Tiling patterns and soft masks: read whenever their resources are. */
  const walkResourceExtras = (resources: PDFDict, page: number, depth: number) => {
    for (const [, value] of lookupDict(resources, "Pattern")?.entries() ?? []) {
      const pattern = resources.context.lookup(value);
      if (pattern instanceof PDFStream) walkForm(pattern, resources, page, { font: undefined, mode: 0 }, depth);
    }
    for (const [, value] of lookupDict(resources, "ExtGState")?.entries() ?? []) {
      const gs = resources.context.lookup(value);
      const smask = gs instanceof PDFDict ? gs.lookup(N("SMask")) : undefined;
      const group = smask instanceof PDFDict ? smask.lookup(N("G")) : undefined;
      if (group instanceof PDFStream) walkForm(group, resources, page, { font: undefined, mode: 0 }, depth);
    }
  };

  pages.forEach((page, p) => {
    const resources = page.node.Resources();
    const { bytes, ok } = pageContent(doc, p);
    if (!ok) problem(p, "content");
    walk(bytes, resources, p, { font: undefined, mode: 0 }, p, 0, true);
    for (const ap of appearanceStreams(page.node.lookup(N("Annots")), doc)) {
      walkForm(ap, undefined, p, { font: undefined, mode: 0 }, 0);
    }
  });
  return facts;
}

function lookupStream(dict: PDFDict | undefined, key: string): PDFStream | undefined {
  const v = dict?.lookup(N(key));
  return v instanceof PDFStream ? v : undefined;
}

/** Every appearance stream of the annotations in `annots` (each state of each kind). */
export function appearanceStreams(annots: PDFObject | undefined, doc: PDFDocument): PDFStream[] {
  const out: PDFStream[] = [];
  if (!(annots instanceof PDFArray)) return out;
  for (let i = 0; i < annots.size(); i++) {
    const annot = annots.lookup(i);
    const ap = annot instanceof PDFDict ? annot.lookup(N("AP")) : undefined;
    if (!(ap instanceof PDFDict)) continue;
    for (const [, kind] of ap.entries()) {
      const value = doc.context.lookup(kind);
      if (value instanceof PDFStream) out.push(value);
      else if (value instanceof PDFDict) {
        for (const [, state] of value.entries()) {
          const s = doc.context.lookup(state);
          if (s instanceof PDFStream) out.push(s);
        }
      }
    }
  }
  return out;
}

/** A number in a dictionary, or `fallback`. */
export function numberIn(dict: PDFDict | undefined, key: string, fallback: number): number {
  const v = dict?.lookup(N(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}
