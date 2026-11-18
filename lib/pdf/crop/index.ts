/**
 * Crop PDF: each chosen page keeps the box the person drew, typed or had
 * found for it. Only pdf-lib, so it runs in a Web Worker (off-thread.ts) as
 * well as here.
 *
 * A plain crop sets the page's boxes (MediaBox, CropBox, TrimBox, BleedBox
 * and ArtBox, so viewers and printers agree) to the area kept. That hides
 * what is outside; it is still in the file, and the page says so. Links,
 * notes and fields wholly outside go; the rest stay where they are.
 *
 * With pictures (./pictures.ts), those pages are rebuilt from a picture of
 * the area kept instead: their old content goes, and with it everything that
 * was outside, for good. Their text inside the box stays searchable as an
 * invisible layer, links inside still work, and comments and fields are
 * part of the picture. Redrawing the old content clipped to the box would
 * look the same but keep all of it in the file, so it isn't offered as
 * removing anything.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  StandardFonts,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
  type PDFStream,
} from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { friendlyPdfError } from "../errors";
import { openPdf } from "../open";
import { dropFields, dropUnreachable, dropXfa } from "../operations";
import { pageFrame } from "../page-frame";
import { textLayer, type OwnText } from "../ocr-layer";
import { compose, invert, moveAnnotation, moveDestinations, type Matrix, type Moved } from "../resize";
import { marginsProblem, type Margins } from "./geometry";

/** A picture of the area kept on one page, made in the browser (./pictures.ts). */
export interface CropPicture {
  /** JPEG bytes. */
  jpeg: Uint8Array;
  /** The page's own text wholly inside the box, in points from the box's top-left corner. */
  text: OwnText[];
}

export interface CropJob {
  /** The pages to crop (0-indexed) and the margins each loses, on the page as shown. Others stay as they are. */
  crops: { page: number; margins: Margins }[];
  /** Pages rebuilt from a picture of the area kept, by page index. */
  pictures?: Record<number, CropPicture>;
}

export interface CropReport {
  /** Pages cropped. */
  cropped: number;
  /** Of those, pages rebuilt from a picture. */
  pictured: number;
  /** Links, notes and fields taken out because they were wholly outside the box. */
  removed: number;
}

const N = {
  Annots: PDFName.of("Annots"),
  Contents: PDFName.of("Contents"),
  Resources: PDFName.of("Resources"),
  Rotate: PDFName.of("Rotate"),
  Rect: PDFName.of("Rect"),
  Subtype: PDFName.of("Subtype"),
  Parent: PDFName.of("Parent"),
  Link: PDFName.of("Link"),
  Popup: PDFName.of("Popup"),
  Widget: PDFName.of("Widget"),
  StructTreeRoot: PDFName.of("StructTreeRoot"),
  MarkInfo: PDFName.of("MarkInfo"),
};
const BOXES = ["MediaBox", "CropBox", "TrimBox", "BleedBox", "ArtBox"].map((key) => PDFName.of(key));
/** What a page keeps about how it looked before: a thumbnail of the whole page, and, once it is a picture, the rest. */
const STALE = ["Thumb"].map((key) => PDFName.of(key));
const STALE_PICTURED = ["PieceInfo", "Metadata", "StructParents", "Group", "B", "VP", "SeparationInfo"].map((key) => PDFName.of(key));

type Rect = { x0: number; y0: number; x1: number; y1: number };

function rectOf(annot: PDFDict): Rect | null {
  const rect = annot.lookup(N.Rect);
  if (!(rect instanceof PDFArray) || rect.size() < 4) return null;
  const v = [0, 1, 2, 3].map((i) => {
    const n = rect.lookup(i);
    return n instanceof PDFNumber ? n.asNumber() : NaN;
  });
  if (v.some((n) => !Number.isFinite(n))) return null;
  return { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), x1: Math.max(v[0], v[2]), y1: Math.max(v[1], v[3]) };
}

/** Whether two rectangles share some area (touching edges don't count). */
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

const subtypeOf = (annot: PDFDict) => {
  const s = annot.lookup(N.Subtype);
  return s instanceof PDFName ? s : undefined;
};

/** The area kept, in the page's own space, and the transform that puts it at 0,0 the right way up. */
function keptArea(page: PDFPage, m: Margins) {
  const frame = pageFrame(page);
  // The frame's v runs up from the bottom edge as shown; margins run from the top.
  const u0 = m.left;
  const u1 = frame.width - m.right;
  const v0 = m.bottom;
  const v1 = frame.height - m.top;
  const a = frame.toPdf(u0, v0);
  const b = frame.toPdf(u1, v1);
  const rect: Rect = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  const upright: Matrix = compose(invert(frame.matrix), [1, 0, 0, 1, -u0, -v0]);
  return { rect, width: u1 - u0, height: v1 - v0, upright, turned: frame.rotation !== 0, frame };
}

/**
 * The page's annotations sorted into those that stay and those that go:
 * wholly outside `rect`, or (once a page is a picture) anything but a link
 * that reaches into it. A popup goes with the note it belongs to.
 */
function sortAnnotations(page: PDFPage, rect: Rect, pictured: boolean): { keep: PDFRef[]; kept: PDFDict[]; gone: PDFDict[] } {
  const annots = page.node.Annots();
  const keep: PDFRef[] = [];
  const kept: PDFDict[] = [];
  const gone = new Set<PDFDict>();
  const popups: [PDFRef | PDFDict, PDFDict][] = [];
  for (let i = 0; i < (annots?.size() ?? 0); i++) {
    const ref = annots!.get(i);
    const annot = annots!.lookup(i);
    if (!(annot instanceof PDFDict)) continue;
    const type = subtypeOf(annot);
    if (type === N.Popup) {
      popups.push([ref as PDFRef, annot]);
      continue;
    }
    const r = rectOf(annot);
    // Without a usable box there is no telling where it is: kept, unless the page became a picture.
    const inside = r ? overlaps(r, rect) : !pictured;
    const stays = inside && (!pictured || type === N.Link);
    if (stays) {
      keep.push(ref as PDFRef);
      kept.push(annot);
    } else gone.add(annot);
  }
  for (const [ref, popup] of popups) {
    const parent = popup.lookup(N.Parent);
    if (pictured || (parent instanceof PDFDict && gone.has(parent))) gone.add(popup);
    else {
      keep.push(ref as PDFRef);
      kept.push(popup);
    }
  }
  return { keep, kept, gone: [...gone] };
}

/**
 * Crops the pages of `bytes` that `job` names. Errors are messages for
 * people. Stops on `signal` between pages.
 */
export async function cropPdf(
  bytes: Uint8Array,
  job: CropJob,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; report: CropReport }> {
  let doc: PDFDocument;
  let pages: PDFPage[];
  try {
    doc = await openPdf(bytes);
    // A header with no document after it opens, then fails here.
    pages = doc.getPages();
  } catch (err) {
    throw friendlyPdfError(err);
  }
  stopIfAborted(signal);
  if (!pages.length) throw new Error("This PDF has no pages.");
  if (!job.crops.length) throw new Error("Pick the pages to crop.");
  const crops = new Map<number, Margins>();
  for (const { page, margins } of job.crops) {
    if (!Number.isInteger(page) || !pages[page]) throw new Error(`This PDF has no page ${page + 1}.`);
    const { width, height } = pageFrame(pages[page]);
    const problem = marginsProblem({ width, height }, margins, page + 1);
    if (problem) throw new Error(problem);
    crops.set(page, margins);
  }

  const { context } = doc;
  const report: CropReport = { cropped: 0, pictured: 0, removed: 0 };
  const goneWidgets = new Set<PDFDict>();
  const moved = new Map<PDFRef, Moved>();
  const turned = new Set<PDFStream>();
  let font: PDFFont | undefined;
  let step = 0;
  for (const [index, margins] of [...crops].sort((a, b) => a[0] - b[0])) {
    stopIfAborted(signal);
    const page = pages[index];
    const picture = job.pictures?.[index];
    // Up to 90%: then the file is written.
    if (picture || step % 20 === 0) onProgress?.((0.9 * step) / crops.size, `Page ${index + 1} of ${pages.length}`);
    step++;
    const area = keptArea(page, margins);
    const { keep, kept, gone } = sortAnnotations(page, area.rect, !!picture);
    for (const annot of gone) {
      if (subtypeOf(annot) === N.Widget) goneWidgets.add(annot);
      // What a picture now shows isn't counted as taken out.
      if (!picture || !overlapsPage(annot, area.rect)) report.removed++;
    }
    // A list of its own: one shared with another page would lose that page's notes too.
    const setAnnots = () => (keep.length ? page.node.set(N.Annots, context.obj(keep)) : page.node.delete(N.Annots));
    for (const key of STALE) page.node.delete(key);

    if (!picture) {
      setAnnots();
      const box = context.obj([area.rect.x0, area.rect.y0, area.rect.x1, area.rect.y1]);
      for (const key of BOXES) page.node.set(key, box);
      report.cropped++;
      continue;
    }

    // The old content goes; the picture, upright, is the whole page now.
    for (const key of STALE_PICTURED) page.node.delete(key);
    page.node.set(N.Contents, context.obj([]));
    page.node.set(N.Resources, context.obj({}));
    page.node.set(N.Rotate, PDFNumber.of(0));
    const box = context.obj([0, 0, area.width, area.height]);
    for (const key of BOXES) page.node.set(key, box);
    const image = await doc.embedJpg(picture.jpeg);
    page.drawImage(image, { x: 0, y: 0, width: area.width, height: area.height });
    if (picture.text.length) {
      font ??= await doc.embedFont(StandardFonts.Helvetica);
      const key = page.node.newFontDictionary("F", font.ref);
      const words = picture.text.map((p) => ({ text: p.text, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, confidence: 100 }));
      page.pushOperators(
        ...textLayer(font, key, { widthPt: area.width, heightPt: area.height, imageWidth: area.width, imageHeight: area.height, words }, 0)
      );
    }
    // Drawing gives the page an empty list of its own first.
    setAnnots();
    // Links stay over what they cover; places linked to on the page move with it.
    for (const annot of kept) moveAnnotation(doc, annot, area.upright, turned);
    moved.set(page.ref, { sheet: page.ref, m: area.upright, turned: area.turned });
    report.cropped++;
    report.pictured++;
  }

  onProgress?.(0.9, "Saving…");
  const picturedPages = new Set([...moved.keys()]);
  if (goneWidgets.size || picturedPages.size) {
    dropFields(doc, (w) => goneWidgets.has(w.dict) || picturedPages.has(w.P() as PDFRef));
    if (picturedPages.size) dropXfa(doc);
  }
  if (moved.size) {
    moveDestinations(doc, moved);
    // The tags describe content that is gone, and can hold its text.
    doc.catalog.delete(N.StructTreeRoot);
    doc.catalog.delete(N.MarkInfo);
  }
  // What only the removed notes, fields and old page content used leaves the file.
  dropUnreachable(doc);
  stopIfAborted(signal);
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: out, report };
}

/** Whether an annotation reaches into the area kept. */
function overlapsPage(annot: PDFDict, rect: Rect): boolean {
  const r = rectOf(annot);
  return !!r && overlaps(r, rect);
}
