import { formatLimitBytes } from "@/lib/limits";

/**
 * Sorts the files of one pick or drop (already filtered to types the tool
 * takes) into the ones to add, and says what happened to the rest. A file
 * over the size limit, or a second file on a one-file tool, never costs the
 * visitor the files that do fit.
 */
export function sortPick(
  accepted: File[],
  skipped: number,
  o: { maxFileBytes: number; multiple: boolean; toolName?: string }
): { keep: File[]; tooBig: number; message: string | null } {
  const fits = accepted.filter((f) => f.size <= o.maxFileBytes);
  const tooBig = accepted.filter((f) => f.size > o.maxFileBytes);
  const notes: string[] = [];
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
  return {
    keep: o.multiple ? fits : fits.slice(0, 1),
    tooBig: tooBig.length,
    message: notes.length ? notes.join(" ") : null,
  };
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
