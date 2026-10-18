import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFStream, type PDFObject, type PDFPageLeaf } from "pdf-lib";
import { scanContent, type Operand } from "./compress/lexer";
import { decodeFully } from "./compress/streams";

/**
 * What a page's own content draws with. Pages often share one resource
 * dictionary holding every image and font of the document (LibreOffice
 * Impress writes one, and many generators put it on the page tree for every
 * page to inherit), so a page copied out of the document with it brings all
 * of them along.
 */

const XObject = PDFName.of("XObject");
const Font = PDFName.of("Font");
const ExtGState = PDFName.of("ExtGState");
const Shading = PDFName.of("Shading");
const Pattern = PDFName.of("Pattern");
const ColorSpace = PDFName.of("ColorSpace");
const Properties = PDFName.of("Properties");
const CATEGORIES = new Set([XObject, Font, ExtGState, Shading, Pattern, ColorSpace, Properties]);
/** Colour spaces a page uses without naming them: they stand in for the device ones. */
const DEFAULT_SPACES = new Set(["DefaultGray", "DefaultRGB", "DefaultCMYK"].map((name) => PDFName.of(name)));
/** Colour space names that aren't resources, with an inline image's short ones. */
const BUILT_IN_SPACES = new Set(["DeviceGray", "DeviceRGB", "DeviceCMYK", "Pattern", "G", "RGB", "CMYK", "I", "Indexed"].map((name) => PDFName.of(name)));

const Contents = PDFName.of("Contents");
const Resources = PDFName.of("Resources");
const Subtype = PDFName.of("Subtype");
const Image = PDFName.of("Image");
const Type3 = PDFName.of("Type3");
const SMask = PDFName.of("SMask");
const G = PDFName.of("G");

/** The resource category an operator names. */
function categoryOf(op: string): PDFName | undefined {
  switch (op) {
    case "Do":
      return XObject;
    case "Tf":
      return Font;
    case "gs":
      return ExtGState;
    case "sh":
      return Shading;
    case "scn":
    case "SCN":
      return Pattern;
    case "cs":
    case "CS":
      return ColorSpace;
    case "BDC":
    case "DP":
      return Properties;
  }
}

/** The names the page's content uses, by category; undefined when some of it can't be read. */
function namesUsed(page: PDFPageLeaf): Map<PDFName, Set<PDFName>> | undefined {
  const { context } = page;
  const contents = page.get(Contents);
  const streams: (PDFObject | undefined)[] = [];
  if (contents !== undefined) {
    const list = context.lookup(contents);
    if (list instanceof PDFArray) for (let i = 0; i < list.size(); i++) streams.push(list.lookup(i));
    else streams.push(list);
  }
  // The streams read as one: an operator's operands can end the one before it.
  const parts: Uint8Array[] = [];
  let length = 0;
  for (const stream of streams) {
    if (!(stream instanceof PDFRawStream)) return undefined;
    const bytes = decodeFully(context, stream, false);
    if (!bytes) return undefined;
    parts.push(bytes);
    length += bytes.length + 1;
  }
  const data = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    data[at + part.length] = 10;
    at += part.length + 1;
  }

  const used = new Map<PDFName, Set<PDFName>>();
  const add = (category: PDFName, operands: (Operand | undefined)[], from = 0) => {
    for (let i = from; i < operands.length; i++) {
      const name = operands[i];
      if (typeof name !== "string") continue;
      let names = used.get(category);
      if (!names) used.set(category, (names = new Set()));
      // The scanner gives names with #xx escapes resolved; so does PDFName,
      // once a "#" left in the name is escaped itself.
      names.add(PDFName.of(name.includes("#") ? name.replace(/#/g, "#23") : name));
    }
  };
  const whole = scanContent(
    data,
    (op, operands) => {
      const category = categoryOf(op);
      // A marked-content operator's first operand is its tag, not a resource.
      if (category) add(category, operands, category === Properties ? 1 : 0);
    },
    {
      strict: true,
      // An inline image can name its colour space, or an indexed one's base.
      onInlineImage: (entries) => add(ColorSpace, [entries.CS ?? entries.ColorSpace].flat()),
    }
  );
  return whole ? used : undefined;
}

const ownDict = (dict: PDFDict) => dict.lookup(Resources) instanceof PDFDict;

/**
 * Whether a resource takes names from the resources of the page that uses
 * it, having none of its own: a form or tiling pattern without /Resources, a
 * Type 3 font without them, or a soft mask drawn by such a form.
 */
function borrows(obj: PDFObject | undefined, category: PDFName): boolean {
  if (category === XObject) return obj instanceof PDFStream && obj.dict.lookup(Subtype) !== Image && !ownDict(obj.dict);
  if (category === Pattern) return obj instanceof PDFStream && !ownDict(obj.dict);
  if (category === Font) return obj instanceof PDFDict && obj.lookup(Subtype) === Type3 && !ownDict(obj);
  if (category === ExtGState) {
    const mask = obj instanceof PDFDict ? obj.lookup(SMask) : undefined;
    const group = mask instanceof PDFDict ? mask.lookup(G) : undefined;
    return group instanceof PDFStream && !ownDict(group.dict);
  }
  return false;
}

/**
 * A resource dictionary for `page` holding only the images, fonts and other
 * resources its content uses, sharing them with the one it has (which stays
 * as it is). What's left out becomes unreachable once no other page uses it.
 * Forms and patterns keep their own resources whole.
 *
 * Undefined when the page should keep what it has: nothing would be left
 * out, some of its content can't be read, or it draws something that looks
 * names up in the page's resources too.
 */
export function ownResources(page: PDFPageLeaf): PDFDict | undefined {
  const { context } = page;
  if (context.trailerInfo.Encrypt) return undefined;
  const resources = context.lookup(page.getInheritableAttribute(Resources));
  if (!(resources instanceof PDFDict)) return undefined;
  const used = namesUsed(page);
  if (!used) return undefined;
  const out = context.obj({});
  const keptBy = new Map<PDFName, PDFDict>();
  let left = 0;
  for (const [category, value] of resources.entries()) {
    const dict = CATEGORIES.has(category) ? context.lookup(value) : undefined;
    if (!(dict instanceof PDFDict)) {
      out.set(category, value);
      continue;
    }
    const names = used.get(category);
    const kept = context.obj({});
    for (const [name, entry] of dict.entries()) {
      if (!names?.has(name) && !(category === ColorSpace && DEFAULT_SPACES.has(name))) {
        left++;
        continue;
      }
      if (borrows(context.lookup(entry), category)) return undefined;
      kept.set(name, entry);
    }
    out.set(category, kept);
    keptBy.set(category, kept);
  }
  // A name the resources don't have: a damaged file, or one written in a way
  // this reads differently from a reader. Leave it as it is.
  for (const [category, names] of used) {
    const kept = keptBy.get(category);
    for (const name of names) {
      if (!kept?.has(name) && !(category === ColorSpace && BUILT_IN_SPACES.has(name))) return undefined;
    }
  }
  return left ? out : undefined;
}
