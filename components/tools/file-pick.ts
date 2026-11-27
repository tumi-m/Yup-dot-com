import { formatLimitBytes } from "@/lib/limits";
import { ENCRYPTED_MESSAGE, UNREADABLE_MESSAGE } from "@/lib/pdf/errors";
import { FORMAT_NAMES, formatsIn } from "@/lib/pdf/images-to-pdf/formats";

/** Types some systems hand over without naming them (an empty type, or "application/octet-stream"). */
const BY_NAME: Record<string, RegExp> = {
  "application/pdf": /\.pdf$/,
  "image/jpeg": /\.jpe?g$/,
  "image/png": /\.png$/,
  "video/mp4": /\.(mp4|m4v)$/,
  "video/quicktime": /\.mov$/,
  "video/webm": /\.webm$/,
};

/**
 * True when a tool's accept list ("image/png,.heic,…") takes the file: by
 * its type, or by its name where the list names the extension or where the
 * browser left the type out (share sheets and some OS pickers do).
 */
export function takesFile(accept: string, file: { name: string; type: string }): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  const untyped = !type || type === "application/octet-stream";
  return accept.split(",").some((entry) => {
    const t = entry.trim().toLowerCase();
    if (!t) return false;
    if (t.startsWith(".")) return name.endsWith(t);
    return type === t || (t === "application/pdf" && name.endsWith(".pdf")) || (untyped && !!BY_NAME[t]?.test(name));
  });
}

/**
 * "a.pdf is empty." for a zero-byte file (a download that never arrived, a
 * cloud file not synced), or "2 files are empty.": every tool would only fail
 * on it, Repair PDF too. Null when none is empty.
 */
export function emptyMessage(files: { name: string; size: number }[]): string | null {
  const empty = files.filter((f) => f.size === 0);
  if (!empty.length) return null;
  return empty.length === 1 ? `${empty[0].name} is empty.` : `${empty.length} files are empty.`;
}

/**
 * Sorts the files of one pick or drop (already filtered to types the tool
 * takes) into the ones to add, and says what happened to the rest. A file
 * over the size limit, an empty one, or a second file on a one-file tool,
 * never costs the visitor the files that do fit.
 */
export function sortPick(
  accepted: File[],
  skipped: number,
  o: {
    maxFileBytes: number;
    multiple: boolean;
    toolName?: string;
    /** Files the plan allows at once, and how many more the list has room for. */
    maxBatchFiles?: number;
    room?: number;
  }
): { keep: File[]; tooBig: number; overBatch: boolean; message: string | null } {
  const empty = emptyMessage(accepted);
  const fits = accepted.filter((f) => f.size > 0 && f.size <= o.maxFileBytes);
  const tooBig = accepted.filter((f) => f.size > o.maxFileBytes);
  const notes: string[] = [];
  if (empty) notes.push(empty);
  if (tooBig.length) {
    const limit = formatLimitBytes(o.maxFileBytes);
    notes.push(
      tooBig.length === 1
        ? `${tooBig[0].name} is over ${limit}, the limit on your plan.`
        : `${tooBig.length} files are over ${limit}, the limit on your plan.`
    );
  }
  if (skipped) notes.push(`Skipped ${skipped} unsupported file${skipped === 1 ? "" : "s"}.`);
  if (!o.multiple && fits.length > 1) {
    notes.push(`${o.toolName ?? "This tool"} takes one file at a time. Using ${fits[0].name}.`);
  }
  // Past the plan's batch size the rest are named, so the note outlasts the upgrade prompt.
  const room = Math.max(0, o.room ?? Infinity);
  const keep = o.multiple ? fits.slice(0, room) : fits.slice(0, 1);
  const left = o.multiple ? fits.slice(keep.length) : [];
  if (left.length) {
    const max = o.maxBatchFiles ?? keep.length;
    const rest = left.length - 1;
    notes.push(
      `${keep.length ? `Added ${keep.length} of ${fits.length}. ` : ""}Up to ${max} files at once on your plan: ` +
        `${left[0].name}${rest ? ` and ${rest} more` : ""} ${left.length === 1 ? "wasn't" : "weren't"} added.`
    );
  }
  return {
    keep,
    tooBig: tooBig.length,
    overBatch: left.length > 0,
    message: notes.length ? notes.join(" ") : null,
  };
}

/** "a, b or c" */
const either = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]);

/** What a tool takes, for a file it can't: "Merge PDF takes PDFs." */
export function takesMessage(toolName: string | undefined, accept: string, multiple: boolean): string {
  // Types say what kind of file; extensions only repeat them.
  const types = accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t && !t.startsWith("."));
  const images = formatsIn(accept).map((f) => FORMAT_NAMES[f]);
  // Text and Markdown, in the order the list gives them.
  const texts = [...new Set(types.map((t) => (t === "text/plain" ? "text" : /markdown/.test(t) ? "Markdown" : "")).filter(Boolean))];
  const all = (test: (t: string) => boolean) => types.length > 0 && types.every(test);
  const what = all((t) => t === "application/pdf")
    ? multiple
      ? "PDFs"
      : "a PDF"
    : images.length && types.every((t) => t.startsWith("image/"))
      ? `${either(images)} images`
      : all((t) => t.startsWith("video/"))
        ? "MP4, MOV or WebM videos"
        : texts.length && all((t) => t.startsWith("text/"))
          ? multiple
            ? `${either(texts)} files`
            : `a ${either(texts)} file`
          : null;
  return what ? `${toolName ?? "This tool"} takes ${what}.` : "That file type isn't supported here.";
}

/**
 * A file name split before its last `keep` characters, so a long start can be
 * truncated while the end ("-page-12.pdf") that tells files apart stays
 * whole. Characters as people see them: an emoji or an accent is never cut
 * in two.
 */
export function splitNameEnd(name: string, keep = 12): [string, string] {
  const chars =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name), (s) => s.segment)
      : Array.from(name);
  if (chars.length <= keep) return ["", name];
  return [chars.slice(0, -keep).join(""), chars.slice(-keep).join("")];
}

/**
 * The "% smaller" a compressed result shows. Rounded down and kept under
 * 100, so a big saving never reads as an empty file.
 */
export function percentSmaller(sizeDelta: number): number {
  return Math.min(99, Math.floor(sizeDelta * 100));
}

/**
 * The tool that fixes what a tool's error says, and the file to take there:
 * the one the message names ("a.pdf: …"), or the only one. Repair PDF for a
 * file that won't read, Unlock PDF for a locked one, OCR PDF for a scan.
 * Null when there is none, or when that tool is the one already open.
 */
export function errorFix<F extends { name: string }>(
  message: string | null,
  files: F[],
  slug: string
): { slug: string; label: string; file: F } | null {
  if (!message) return null;
  const file = files.find((f) => message.startsWith(`${f.name}: `)) ?? (files.length === 1 ? files[0] : undefined);
  if (!file) return null;
  if (message.endsWith(UNREADABLE_MESSAGE) && slug !== "repair-pdf") return { slug: "repair-pdf", label: "Try Repair PDF", file };
  // Repair PDF's own wording ("…Unlock it first, then repair it.") counts too;
  // a locked PowerPoint ("This file is password-protected…") is no PDF to unlock.
  if (message.includes(ENCRYPTED_MESSAGE.replace(/\.$/, "")) && slug !== "unlock-pdf") return { slug: "unlock-pdf", label: "Open in Unlock PDF", file };
  if (message.includes("scanned PDF") && slug !== "ocr-pdf") return { slug: "ocr-pdf", label: "Run OCR PDF", file };
  return null;
}
