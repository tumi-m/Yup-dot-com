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
