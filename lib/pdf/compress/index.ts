/**
 * PDF compression that keeps the document a document: text, links,
 * bookmarks, forms and vector art are untouched. Bytes come from images
 * (downsampled to what their placement on the page needs, then stored as
 * JPEG or lossless Flate, whichever suits the picture) and from lossless
 * clean-up (better Flate, shared duplicates, unused objects, object streams).
 *
 * Pure TypeScript on pdf-lib, so it runs in the browser and in Node tests.
 */
import { PDFDocument, PDFName, PDFRawStream, type PDFContext } from "pdf-lib";
import { dedupe, directLengths, dropUnreachable, recompressStreams, stripPrivateData } from "./cleanup";
import { optimiseImages, type ImageSettings } from "./images";
import { asDict, findPlacements, listPages } from "./placement";
import { decodeFully } from "./streams";
import { stopIfAborted } from "../../abort";

export type Preset = "smallest" | "balanced" | "high";

// Tuned on photo, scan and slide PDFs by size against SSIM of 150 DPI renders.
// The two smaller presets also resample images only a little too sharp, such
// as the 200 PPI pages common from scanners and phone scanning apps.
export const PRESETS: Record<Preset, ImageSettings> = {
  smallest: { dpi: 100, quality: 40, threshold: 1.2 },
  balanced: { dpi: 144, quality: 45, threshold: 1.2 },
  high: { dpi: 200, quality: 70, threshold: 1.4 },
};

/** A preset name, also accepting the old quality values ("0.4", "0.6", "0.8"). */
export function presetFrom(value: string | undefined): Preset {
  if (value === "smallest" || value === "0.4") return "smallest";
  if (value === "high" || value === "0.8") return "high";
  return "balanced";
}

/** pdf-lib couldn't make sense of the file (damaged, or not a PDF it understands). */
export class UnreadablePdfError extends Error {}

export interface CompressOptions {
  preset: Preset;
  onProgress?: (fraction: number, label: string) => void;
  /** Stops between images once aborted. */
  signal?: AbortSignal;
}

/** PDF/A-1 builds on PDF 1.4, which has no object streams, so such files are saved without them. */
function isPdfA1(context: PDFContext): boolean {
  const metadata = asDict(context.lookup(context.trailerInfo.Root))?.lookup(PDFName.of("Metadata"));
  const bytes = metadata instanceof PDFRawStream ? decodeFully(context, metadata) : null;
  if (!bytes) return false;
  const xmp = new TextDecoder("latin1").decode(bytes);
  return /pdfaid:part\s*(=\s*["']1["']|>\s*1\s*<)/.test(xmp);
}

async function open(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (!/encrypted/i.test(err instanceof Error ? err.message : "")) throw new UnreadablePdfError("unreadable");
    // Restricted but not locked (an owner password only): it opens with an empty password.
    let plain: Uint8Array;
    try {
      const { PDFDocument: SecureDocument } = await import("@cantoo/pdf-lib");
      const secure = await SecureDocument.load(bytes, { password: "", updateMetadata: false });
      // Decrypting a file with a cross-reference stream loses the trailer's
      // Info (title, author) and ID: take them from the file as stored.
      const trailer = secure.context.trailerInfo;
      if (!trailer.Info || !trailer.ID) {
        const stored = (await SecureDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).context.trailerInfo;
        trailer.Info ??= stored.Info;
        trailer.ID ??= stored.ID;
      }
      plain = await secure.save();
    } catch (decryptErr) {
      if (/password/i.test(decryptErr instanceof Error ? decryptErr.message : "")) throw err;
      throw new UnreadablePdfError("unreadable");
    }
    try {
      return await PDFDocument.load(plain, { updateMetadata: false });
    } catch {
      throw new UnreadablePdfError("unreadable");
    }
  }
}

export async function compressPdf(bytes: Uint8Array, opts: CompressOptions): Promise<Uint8Array> {
  const doc = await open(bytes);
  const context = doc.context;
  if (!listPages(context).length) throw new UnreadablePdfError("no pages");

  stripPrivateData(context, listPages(context));
  directLengths(context);
  dedupe(context);
  dropUnreachable(context);

  const pages = listPages(context);
  const placements = findPlacements(context, pages);
  const report = await optimiseImages(context, pages, placements, PRESETS[opts.preset], (done, total) => {
    stopIfAborted(opts.signal);
    if (total) opts.onProgress?.((done / total) * 0.9, `Image ${Math.min(Math.floor(done) + 1, total)} of ${total}`);
  });
  stopIfAborted(opts.signal);
  opts.onProgress?.(0.92, "Saving…");
  await new Promise((r) => setTimeout(r, 0)); // let the label show before the save runs
  recompressStreams(context, report.rewritten);
  dropUnreachable(context);
  return doc.save({ useObjectStreams: !isPdfA1(context), addDefaultPage: false, updateFieldAppearances: false });
}
