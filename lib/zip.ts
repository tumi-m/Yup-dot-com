import type JSZip from "jszip";

/**
 * How each file goes into a zip the app hands out (results bundles, .pptx,
 * .xlsx): text-like files are deflated hard, since they shrink several times
 * over and are small; files that are already compressed are stored as they
 * are, where deflate would only burn CPU for a percent or two.
 */

/** Already compressed: images, audio, video, archives and Office files (which are zips). */
const STORED =
  /\.(jpe?g|png|gif|webp|avif|heic|mp3|m4a|aac|ogg|oga|opus|wma|flac|mp4|m4v|mov|webm|mkv|avi|wmv|ogv|mpe?g|zip|gz|7z|rar|docx|xlsx|pptx|odt|ods|odp|woff2?)$/i;
/** Small, very compressible: worth the slowest, smallest deflate. */
const TEXT = /\.(xml|rels|vml|txt|csv|tsv|md|json|html?|svg|css|js)$/i;

export function zipEntryOptions(name: string): JSZip.JSZipFileOptions {
  if (STORED.test(name)) return { compression: "STORE" };
  if (TEXT.test(name)) return { compression: "DEFLATE", compressionOptions: { level: 9 } };
  // Anything else (PDFs, fonts, unknown parts): deflate at the usual level.
  return { compression: "DEFLATE", compressionOptions: { level: 6 } };
}

/** Bytes deflated to judge a file whose name doesn't say whether it compresses. */
const SAMPLE = 64 * 1024;

/**
 * zipEntryOptions, after a look inside files a name can't settle: a PDF of
 * text and vector graphics deflates well, a PDF of scans or photos barely
 * shrinks, and deflating hundreds of megabytes for 1% would stall the page.
 * Deflates a few slices spread through the file and stores it when they
 * shrink by less than 5%.
 */
export async function zipEntryOptionsFor(name: string, data: Blob): Promise<JSZip.JSZipFileOptions> {
  const opts = zipEntryOptions(name);
  if (opts.compression !== "DEFLATE" || TEXT.test(name) || data.size <= SAMPLE * 4 || typeof CompressionStream !== "function") {
    return opts;
  }
  try {
    const step = (data.size - SAMPLE) / 3;
    const sample = new Blob([0, 1, 2, 3].map((i) => data.slice(Math.round(i * step), Math.round(i * step) + SAMPLE)));
    const deflated = await new Response(sample.stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
    return deflated.byteLength > sample.size * 0.95 ? { compression: "STORE" } : opts;
  } catch {
    return opts;
  }
}
