import JSZip from "jszip";
import { parse as pptxToJson } from "pptxtojson";
import type {
  Element as PElement,
  Fill as PFill,
  Group as PGroup,
} from "pptxtojson";
import { analyzeSlide, slideOrder, type ParaInfo, type SlideAnalysis, type TableFlags } from "./ooxml";

/**
 * Loads a .pptx into a typed deck model for rendering.
 *
 * The heavy lifting (geometry, fills, preset shape paths, run styles) is done
 * by pptxtojson; ./ooxml then reads the XML directly to add what it misses
 * (inherited bullets and indents, real slide order, hidden slides, z-order).
 *
 * Element ids: every element's `id` is the `id` attribute of the shape's
 * <p:cNvPr> in the part it came from — pptxtojson reads it from
 * p:nvSpPr / p:nvPicPr / p:nvCxnSpPr / p:nvGrpSpPr / p:nvGraphicFramePr, or
 * inside mc:AlternateContent (verified against the XML in
 * tests/pptx-parse.test.mts). For `slide.elements`, including children of
 * groups, that is unique within the slide's XML part (ppt/slides/slideN.xml),
 * so an editor can map a clicked element back to its <p:sp> by that id.
 * Layout/master decorations (`slide.layoutElements`) come from other parts and
 * their ids may collide with slide ids, so they are never selectable.
 * SmartArt children carry ids from the diagram drawing part, not the slide.
 * All positions and sizes are in points (1/72 in), relative to the slide or,
 * for group children, to the group's box.
 */

export type Fill = PFill | null;

export interface ElementExtras {
  /** Paragraph metadata (bullets, indents, spacing) in paragraph order. */
  paragraphs?: ParaInfo[];
  /** Placeholder type (title, body, subTitle, ...) when the shape is one. */
  phType?: string;
  /** Vertical anchor of a placeholder, resolved by type (t, ctr, b). */
  anchor?: string;
  /** Table style switches, for tables using a built-in style. */
  tableFlags?: TableFlags;
}

export type DeckElement = PElement & ElementExtras;
export type DeckGroup = PGroup & ElementExtras;

export interface DeckSlide {
  /** 1-based position in the presentation. */
  number: number;
  /** Hidden slides are skipped when exporting, like PowerPoint does. */
  hidden: boolean;
  fill: Fill;
  /** The slide's own shapes, in z-order (back to front). */
  elements: DeckElement[];
  /** Non-placeholder shapes from the master, then the layout (drawn first). */
  layoutElements: DeckElement[];
  note: string;
  /** XML part path, e.g. ppt/slides/slide3.xml. */
  part: string;
  /** Theme hyperlink colour. */
  linkColor?: string;
}

export interface Deck {
  /** Slide size in points. */
  width: number;
  height: number;
  slides: DeckSlide[];
  themeColors: string[];
}

export class PptxError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "legacy" | "encrypted" | "empty"
  ) {
    super(message);
    this.name = "PptxError";
  }
}

export const PPTX_MESSAGES = {
  invalid: "This file isn't a valid .pptx.",
  legacy: "Save it as .pptx first.",
  encrypted: "This file is password-protected. Remove the password first.",
  empty: "This presentation has no slides.",
} as const;

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]) {
  return magic.every((b, i) => bytes[i] === b);
}

/** "EncryptedPackage" as UTF-16LE: the stream name of an encrypted OOXML file. */
function hasEncryptedPackage(bytes: Uint8Array) {
  const needle = Array.from("EncryptedPackage").flatMap((c) => [c.charCodeAt(0), 0]);
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Classifies a file before parsing; throws a PptxError for anything but a zip. */
export function sniffPptx(bytes: Uint8Array) {
  if (startsWith(bytes, CFB_MAGIC)) {
    // Both legacy .ppt and password-protected .pptx are OLE compound files.
    if (hasEncryptedPackage(bytes)) throw new PptxError(PPTX_MESSAGES.encrypted, "encrypted");
    throw new PptxError(PPTX_MESSAGES.legacy, "legacy");
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new PptxError(PPTX_MESSAGES.invalid, "invalid");
}

const byOrder = (a: { order?: number | string }, b: { order?: number | string }) =>
  Number(a.order ?? 0) - Number(b.order ?? 0);

function isGroup(el: PElement): el is PGroup {
  return el.type === "group";
}

/** Sorts shapes back-to-front and attaches paragraph metadata, recursively. */
function prepare(elements: PElement[], info: SlideAnalysis | null, zOf?: (el: PElement) => number): DeckElement[] {
  const z = zOf ?? ((el: PElement) => info?.zOrder[el.id] ?? Number.MAX_SAFE_INTEGER);
  const sorted = [...elements].sort((a, b) => z(a) - z(b) || byOrder(a, b));
  return sorted.map((el) => {
    const out = { ...el } as DeckElement;
    if (isGroup(el)) {
      (out as DeckGroup).elements = prepare(el.elements, info, zOf) as PGroup["elements"];
    } else if (info && (el.type === "text" || el.type === "shape")) {
      const shape = info.shapes[el.id];
      if (shape) {
        out.paragraphs = shape.paragraphs;
        if (shape.phType) out.phType = shape.phType;
        if (shape.anchor) out.anchor = shape.anchor;
      }
      const line = info.lineColors[el.id];
      if (line) (out as { borderColor: string }).borderColor = line;
    } else if (info && el.type === "table" && info.tables[el.id]) {
      out.tableFlags = info.tables[el.id];
    }
    return out;
  });
}

/**
 * pptxtojson returns layout shapes followed by master shapes, each run grouped
 * by tag. Masters sit underneath layouts, so split the runs and swap them.
 */
function orderLayoutElements(elements: PElement[], info: SlideAnalysis): DeckElement[] {
  const layoutIds = new Set(info.layoutIds);
  let split = 0;
  while (split < elements.length && split < layoutIds.size && layoutIds.has(elements[split].id)) split++;
  const rank = (ids: string[]) => {
    const pos = new Map(ids.map((id, i) => [id, i]));
    return (el: PElement) => pos.get(el.id) ?? Number.MAX_SAFE_INTEGER;
  };
  const layout = prepare(elements.slice(0, split), null, rank(info.layoutIds));
  const master = prepare(elements.slice(split), null, rank(info.masterIds));
  return [...master, ...layout];
}

function slideNumberOf(part: string) {
  const m = /(\d+)\.xml$/.exec(part);
  return m ? Number(m[1]) : 0;
}

export async function parsePptx(input: ArrayBuffer | Uint8Array): Promise<Deck> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  sniffPptx(bytes);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new PptxError(PPTX_MESSAGES.invalid, "invalid");
  }
  if (!zip.file("ppt/presentation.xml") || !zip.file("[Content_Types].xml")) {
    throw new PptxError(PPTX_MESSAGES.invalid, "invalid");
  }

  const read = async (p: string) => (zip.file(p) ? zip.file(p)!.async("string") : null);

  let json: Awaited<ReturnType<typeof pptxToJson>>;
  try {
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    json = await pptxToJson(buf, { imageMode: "base64", videoMode: "none", audioMode: "none", singleLineSpacingFactor: 1.2 });
  } catch {
    throw new PptxError(PPTX_MESSAGES.invalid, "invalid");
  }

  // pptxtojson emits slides sorted by part number; map them back to parts.
  const ct = await read("[Content_Types].xml");
  const parts = Array.from((ct ?? "").matchAll(/PartName="\/(ppt\/slides\/slide\d+\.xml)"/g), (m) => m[1]).sort(
    (a, b) => slideNumberOf(a) - slideNumberOf(b)
  );
  const byPart = new Map(parts.map((p, i) => [p, json.slides[i]]));
  const order = (await slideOrder(read)).filter((p) => byPart.has(p));
  const sequence = order.length ? order : parts;

  const slides: DeckSlide[] = [];
  for (const part of sequence) {
    const src = byPart.get(part);
    if (!src) continue;
    let info: SlideAnalysis | null = null;
    try {
      info = await analyzeSlide(read, part);
    } catch {
      info = null; // Extras are best-effort; the pptxtojson output still renders.
    }
    slides.push({
      number: slides.length + 1,
      hidden: info?.hidden ?? false,
      fill: src.fill ?? null,
      elements: prepare(src.elements ?? [], info),
      layoutElements: info ? orderLayoutElements(src.layoutElements ?? [], info) : prepare(src.layoutElements ?? [], null),
      note: src.note ?? "",
      part,
      linkColor: info?.linkColor,
    });
  }

  if (!slides.length) throw new PptxError(PPTX_MESSAGES.empty, "empty");

  return {
    width: json.size.width,
    height: json.size.height,
    slides,
    themeColors: json.themeColors ?? [],
  };
}

/** A short, user-facing message for any error thrown while parsing. */
export function pptxErrorMessage(err: unknown): string {
  return err instanceof PptxError ? err.message : PPTX_MESSAGES.invalid;
}
