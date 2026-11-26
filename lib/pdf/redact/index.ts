/**
 * Redact PDF: each page with a mark is rebuilt from a picture of it with
 * the marks painted black, so what was under them is no longer in the file.
 * The rest of the page's words can stay searchable as an invisible layer;
 * the words under the marks never go into it. Pages without marks stay as
 * they are. Only pdf-lib, so it runs in a Web Worker (off-thread.ts).
 *
 * The page keeps its size, boxes and turn: the picture is drawn in the page
 * as it is shown, so links and bookmarks still land where they did.
 *
 * Whatever marks there are, the file also loses what could give the text
 * away elsewhere: its details (/Info) and XMP metadata, scripts, attached
 * files, page thumbnails, the tags of rebuilt pages, the comments and fields
 * on them (they are part of the picture now), links over a mark, and
 * bookmark titles holding a redacted word. Then everything nothing uses is
 * dropped, and the file written is searched for the redacted text
 * (./scan.ts) before anyone can download it.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  popGraphicsState,
  pushGraphicsState,
  type PDFDocument,
  type PDFFont,
  type PDFObject,
  type PDFPage,
} from "pdf-lib";
import { stopIfAborted } from "../../abort";
import { friendlyPdfError } from "../errors";
import { openPdf } from "../open";
import { dropFields, dropUnreachable, dropXfa } from "../operations";
import { pageFrame } from "../page-frame";
import { textLayer } from "../ocr-layer";
import { countIn, squeezedIn, touches, type Needle, type Rect } from "./marks";
import { findLeaks, type Leak } from "./scan";

/** One marked page's picture, made in the browser (./pictures.ts). */
export interface RedactPicture {
  /** JPEG bytes of the page as shown, the marks painted black. */
  jpeg: Uint8Array;
  /** Words to keep searchable, in displayed points from the top-left: none under a mark. */
  words: { text: string; x0: number; y0: number; x1: number; y1: number }[];
}

export interface RedactJob {
  /** Pages to rebuild (0-indexed), their marks in displayed points from the top-left, and their pictures. */
  pages: { page: number; rects: Rect[]; picture: RedactPicture }[];
  /** The text the marks take away, to keep out of bookmarks and to look for in the result. */
  needles: Needle[];
}

export interface RedactReport {
  /** Pages rebuilt. */
  pages: number;
  /** Areas blacked out. */
  areas: number;
  /** Comments and links taken off rebuilt pages, and attached files' notes anywhere. */
  annotations: number;
  /** Form fields taken out. */
  fields: number;
  /** Bookmarks whose title gave the text away. */
  bookmarks: number;
  /** Attached files taken out. */
  attachments: number;
  /** Scripts taken out. */
  scripts: number;
  /** Redacted text still found in the written file: none, or the file must not be offered. */
  leaks: Leak[];
}

const N = {
  A: PDFName.of("A"),
  AA: PDFName.of("AA"),
  AF: PDFName.of("AF"),
  Annots: PDFName.of("Annots"),
  Collection: PDFName.of("Collection"),
  Contents: PDFName.of("Contents"),
  EmbeddedFiles: PDFName.of("EmbeddedFiles"),
  First: PDFName.of("First"),
  JavaScript: PDFName.of("JavaScript"),
  Link: PDFName.of("Link"),
  MarkInfo: PDFName.of("MarkInfo"),
  Metadata: PDFName.of("Metadata"),
  Names: PDFName.of("Names"),
  Next: PDFName.of("Next"),
  OpenAction: PDFName.of("OpenAction"),
  Outlines: PDFName.of("Outlines"),
  PieceInfo: PDFName.of("PieceInfo"),
  Rect: PDFName.of("Rect"),
  Resources: PDFName.of("Resources"),
  S: PDFName.of("S"),
  StructTreeRoot: PDFName.of("StructTreeRoot"),
  Subtype: PDFName.of("Subtype"),
  FileAttachment: PDFName.of("FileAttachment"),
  Thumb: PDFName.of("Thumb"),
  Title: PDFName.of("Title"),
  Widget: PDFName.of("Widget"),
};
/** What a rebuilt page keeps about how it was drawn before. */
const STALE = ["Thumb", "PieceInfo", "Metadata", "StructParents", "Group", "B", "VP", "SeparationInfo", "AA", "Trans", "Dur"].map((k) =>
  PDFName.of(k)
);
/** Actions that run something: scripts, programs, or files that come with the document. */
const RUNS = new Set(["JavaScript", "Launch", "ImportData", "RichMediaExecute", "GoToE", "Rendition"]);

/** The strings a dictionary holds directly, and in its action. */
function stringsOf(dict: PDFDict): string {
  const out: string[] = [];
  const add = (o: PDFObject | undefined) => {
    if (o instanceof PDFString || o instanceof PDFHexString) out.push(o.decodeText());
    else if (o instanceof PDFArray) o.asArray().forEach(add);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) add(v instanceof PDFRef ? undefined : v);
  };
  for (const [k, v] of dict.entries()) add(k === N.A ? dict.lookup(N.A) : v);
  return out.join("\n");
}

const holdsAny = (text: string, needles: Needle[]) => needles.some((n) => countIn(text, n) > 0 || squeezedIn(text, n));

function rectOf(annot: PDFDict): Rect | null {
  const r = annot.lookup(N.Rect);
  if (!(r instanceof PDFArray) || r.size() < 4) return null;
  const v = [0, 1, 2, 3].map((i) => Number((r.lookup(i) as { asNumber?: () => number })?.asNumber?.()));
  if (v.some((n) => !Number.isFinite(n))) return null;
  return { x0: Math.min(v[0], v[2]), y0: Math.min(v[1], v[3]), x1: Math.max(v[0], v[2]), y1: Math.max(v[1], v[3]) };
}

/** A mark (displayed, from the top-left) in the page's own space. */
function inPageSpace(page: PDFPage, r: Rect): Rect {
  const frame = pageFrame(page);
  const a = frame.toPdf(r.x0, frame.height - r.y0);
  const b = frame.toPdf(r.x1, frame.height - r.y1);
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/**
 * Redacts `bytes` as `job` says, and searches what it wrote for the
 * redacted text. Errors are messages for people. Stops on `signal`.
 */
export async function redactPdf(
  bytes: Uint8Array,
  job: RedactJob,
  onProgress?: (fraction: number, label: string) => void,
  signal?: AbortSignal
): Promise<{ bytes: Uint8Array; report: RedactReport }> {
  let doc: PDFDocument;
  let pages: PDFPage[];
  try {
    doc = await openPdf(bytes);
    pages = doc.getPages();
  } catch (err) {
    throw friendlyPdfError(err);
  }
  stopIfAborted(signal);
  if (!pages.length) throw new Error("This PDF has no pages.");
  for (const { page } of job.pages) if (!Number.isInteger(page) || !pages[page]) throw new Error(`This PDF has no page ${page + 1}.`);

  const { context } = doc;
  const report: RedactReport = { pages: 0, areas: 0, annotations: 0, fields: 0, bookmarks: 0, attachments: 0, scripts: 0, leaks: [] };
  const goneWidgets = new Set<PDFDict>();
  let font: PDFFont | undefined;
  const todo = [...job.pages].sort((a, b) => a.page - b.page);
  for (const [k, { page: index, rects, picture }] of todo.entries()) {
    stopIfAborted(signal);
    // Up to 70%: then the clean-up, the file and the search through it.
    onProgress?.((0.7 * k) / todo.length, `Page ${index + 1} of ${pages.length}`);
    const page = pages[index];
    const frame = pageFrame(page);
    const marked = rects.map((r) => inPageSpace(page, r));

    // Comments and fields are in the picture now. Links stay unless they touch a mark or name what it hides.
    const annots = page.node.Annots();
    const keep: PDFObject[] = [];
    for (let i = 0; i < (annots?.size() ?? 0); i++) {
      const annot = annots!.lookup(i);
      if (!(annot instanceof PDFDict)) continue;
      const type = annot.lookup(N.Subtype);
      const r = rectOf(annot);
      const stays = type === N.Link && r && !marked.some((m) => touches(m, r)) && !holdsAny(stringsOf(annot), job.needles);
      if (stays) {
        // A link's own script goes with the rest below.
        keep.push(annots!.get(i));
        continue;
      }
      if (type === N.Widget) goneWidgets.add(annot);
      report.annotations++;
    }
    if (keep.length) page.node.set(N.Annots, context.obj(keep));
    else page.node.delete(N.Annots);

    for (const key of STALE) page.node.delete(key);
    page.node.set(N.Contents, context.obj([]));
    page.node.set(N.Resources, context.obj({}));
    const image = await doc.embedJpg(picture.jpeg);
    // Drawn in the page as shown: its boxes and turn stay, so nothing that points at it moves.
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...frame.matrix));
    page.drawImage(image, { x: 0, y: 0, width: frame.width, height: frame.height });
    if (picture.words.length) {
      font ??= await doc.embedFont(StandardFonts.Helvetica);
      const key = page.node.newFontDictionary("F", font.ref);
      const words = picture.words.map((w) => ({ ...w, confidence: 100 }));
      page.pushOperators(
        ...textLayer(font, key, { widthPt: frame.width, heightPt: frame.height, imageWidth: frame.width, imageHeight: frame.height, words }, 0)
      );
    }
    page.pushOperators(popGraphicsState());
    report.pages++;
    report.areas += rects.length;
  }

  onProgress?.(0.7, "Removing hidden data…");
  stopIfAborted(signal);
  if (goneWidgets.size) dropFields(doc, (w) => goneWidgets.has(w.dict));
  report.fields += countGoneFields(goneWidgets);
  scrub(doc, job.needles, report);
  if (report.pages) {
    // The tags describe content that is gone, and can hold its text (/ActualText, /Alt).
    doc.catalog.delete(N.StructTreeRoot);
    doc.catalog.delete(N.MarkInfo);
  }
  dropUnreachable(doc);
  stopIfAborted(signal);
  onProgress?.(0.8, "Saving…");
  const out = await doc.save({ updateFieldAppearances: false });
  stopIfAborted(signal);
  onProgress?.(0.9, "Checking the file…");
  report.leaks = await findLeaks(out, job.needles, signal);
  stopIfAborted(signal);
  return { bytes: out, report };
}

/** How far a widened page reaches each way, in points: far past where any content is drawn. */
const WIDE = 1_000_000;

/**
 * A copy of the file with every page's boxes made very large, only for
 * reading: pdf.js leaves out text outside a page's visible area (a crop
 * hides it, but it is still in the file), and in this copy nothing is
 * outside. Text keeps its place in the page's own space, so it is measured
 * against the real page.
 */
export async function widenBoxes(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await openPdf(bytes);
  for (const page of doc.getPages()) {
    for (const key of ["MediaBox", "CropBox"]) page.node.set(PDFName.of(key), doc.context.obj([-WIDE, -WIDE, WIDE, WIDE]));
  }
  return doc.save({ updateFieldAppearances: false });
}

/** How many fields the removed widgets belonged to. */
function countGoneFields(widgets: Set<PDFDict>): number {
  const fields = new Set<PDFDict>();
  for (const w of widgets) {
    const parent = w.lookup(PDFName.of("Parent"));
    // A widget with no /Parent is its own field.
    fields.add(parent instanceof PDFDict && !w.has(PDFName.of("T")) ? parent : w);
  }
  return fields.size;
}

/** Takes out, all through the document, what can carry text or run code away from the pages. */
function scrub(doc: PDFDocument, needles: Needle[], report: RedactReport) {
  const { context, catalog } = doc;
  // The document's details and XMP metadata, its title among them.
  delete context.trailerInfo.Info;
  catalog.delete(N.Metadata);
  catalog.delete(N.PieceInfo);
  catalog.delete(N.Collection);
  if (catalog.getAcroForm()?.dict.has(PDFName.of("XFA"))) {
    // XFA keeps its own copy of the form's data.
    dropXfa(doc);
    report.fields++;
  }

  const names = catalog.lookup(N.Names);
  if (names instanceof PDFDict) {
    if (names.has(N.JavaScript)) {
      names.delete(N.JavaScript);
      report.scripts++;
    }
    if (names.has(N.EmbeddedFiles)) {
      names.delete(N.EmbeddedFiles);
      report.attachments++;
    }
  }

  // Attached files shown as notes, on any page.
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = annots.lookup(i);
      if (annot instanceof PDFDict && annot.lookup(N.Subtype) === N.FileAttachment) {
        annots.remove(i);
        report.attachments++;
      }
    }
    page.node.delete(N.Thumb);
    page.node.delete(N.PieceInfo);
  }

  // Scripts and metadata hang off anything: pages, links, fields, bookmarks, pictures.
  const seen = new Set<PDFObject>();
  const visit = (o: PDFObject | undefined) => {
    if (!o || seen.has(o)) return;
    seen.add(o);
    const dict = o instanceof PDFStream ? o.dict : o instanceof PDFDict ? o : null;
    if (dict) {
      if (dict.has(N.AA)) {
        dict.delete(N.AA);
        report.scripts++;
      }
      for (const key of [N.A, N.OpenAction, N.Next]) {
        const action = dict.lookup(key);
        if (action instanceof PDFDict && RUNS.has((action.lookup(N.S) as PDFName | undefined)?.decodeText?.() ?? "")) {
          dict.delete(key);
          report.scripts++;
        } else if (action instanceof PDFArray) {
          for (let i = action.size() - 1; i >= 0; i--) {
            const a = action.lookup(i);
            if (a instanceof PDFDict && RUNS.has((a.lookup(N.S) as PDFName | undefined)?.decodeText?.() ?? "")) {
              action.remove(i);
              report.scripts++;
            }
          }
        }
      }
      dict.delete(N.Metadata);
      if (dict.has(N.AF)) {
        dict.delete(N.AF);
        report.attachments++;
      }
      for (const [, v] of dict.entries()) if (!(v instanceof PDFRef)) visit(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) if (!(v instanceof PDFRef)) visit(v);
    }
  };
  for (const [, obj] of context.enumerateIndirectObjects()) visit(obj);

  // Bookmarks that name what was taken away keep their place, not their title.
  if (needles.length) {
    const done = new Set<PDFDict>();
    const walk = (item: PDFObject | undefined) => {
      for (let node = item instanceof PDFDict ? item : undefined; node && !done.has(node); ) {
        done.add(node);
        const title = node.lookup(N.Title);
        if ((title instanceof PDFString || title instanceof PDFHexString) && holdsAny(title.decodeText(), needles)) {
          node.set(N.Title, PDFHexString.fromText("Redacted"));
          report.bookmarks++;
        }
        walk(node.lookup(N.First));
        const next = node.lookup(N.Next);
        node = next instanceof PDFDict ? next : undefined;
      }
    };
    const outlines = catalog.lookup(N.Outlines);
    if (outlines instanceof PDFDict) walk(outlines.lookup(N.First));
  }
}
