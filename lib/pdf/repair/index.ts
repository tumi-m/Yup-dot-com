/**
 * Repair PDF: a damaged file (cut off, junk around it, a broken or missing
 * index, damaged objects, a broken page list) back into one that opens.
 *
 * 1. The bytes are salvaged and pdf-lib reads every object it can, rebuilds
 *    the page list and copies each page that is whole as it was (in a
 *    worker: ./rebuild.ts).
 * 2. Pages it can't copy, and every page of a file it can't read at all, are
 *    drawn by pdf.js as pictures with their text kept searchable
 *    (./pictures.ts), and put in their places.
 * 3. The report says what came back and what didn't. A file with nothing to
 *    recover is refused: never an empty or blank PDF.
 */
import { loadForRender, type LoadedPdf } from "../render";
import { TooManyPixelsError } from "../raster";
import { stopIfAborted } from "../../abort";
import { drawPictures, type Drawn } from "./pictures";
import { rebuildFile, spliceFile } from "./off-thread";
import { NothingRecoveredError, type Extras, type Fix } from "./rebuild";

export { NothingRecoveredError } from "./rebuild";
export { NotAPdfError } from "./salvage";

// The page offers Unlock PDF after it (errorFix in components/tools/file-pick.ts).
export const NEEDS_UNLOCK = "This PDF is password-protected. Unlock it first, then repair it.";
const TOO_MANY = "This file has too many damaged pages to draw again in a browser tab.";

export interface RepairReport {
  /** Pages in the repaired file. */
  pages: number;
  /** Pages the file had, as far as can be told. */
  of: number;
  /** Pages of the repaired file (1-based) that are pictures now. */
  pictures: number[];
  /** Of those, the ones whose text was laid over the picture. */
  searchable: number[];
  /** Pages of the repaired file that were cut off: only their start is there. */
  partial: number[];
  /** Pages of the original (1-based) that couldn't be read, left out. */
  lost: number[];
  fixes: Fix[];
  before: Extras;
  after: Extras;
}

export interface RepairOptions {
  progress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
  /** A fresh canvas; Node tests pass node-canvas. */
  canvas?: () => HTMLCanvasElement;
}

const UNDECRYPTABLE = "This PDF is locked with encryption, and the part needed to unlock it is damaged, so nothing in it could be recovered.";

/** A pdf.js copy of the file, or why there is none. */
async function openForPictures(sources: (() => Promise<Uint8Array>)[], encrypted = false): Promise<LoadedPdf> {
  for (const source of sources) {
    try {
      return await loadForRender(await source());
    } catch (err) {
      if ((err as { name?: string })?.name === "PasswordException") throw new Error(NEEDS_UNLOCK);
    }
  }
  throw new NothingRecoveredError(encrypted ? UNDECRYPTABLE : "This file is too damaged to open: nothing in it could be recovered.");
}

/** Pictures of `pages`, with the reason for a refusal said for people. */
async function pictures(loaded: LoadedPdf, pages: number[], opts: RepairOptions, from: number, to: number): Promise<Drawn> {
  try {
    return await drawPictures(loaded, pages, {
      ...opts,
      progress: (f, label) => opts.progress?.(from + f * (to - from), label),
    });
  } catch (err) {
    if (err instanceof TooManyPixelsError) throw new Error(TOO_MANY);
    throw err;
  } finally {
    loaded.destroy();
  }
}

/**
 * Each found page's number in the original, and the original's pages that
 * weren't found at all. `missing` says where among the found pages a page
 * that couldn't be read sat; pages the count says there were beyond those
 * are put with the last of them (a lost part of the tree holds several), or
 * at the end, where a cut-off file loses them.
 */
export function originalNumbers(found: number, missing: number[], declared: number): { number: number[]; lost: number[] } {
  const gaps = missing.length ? missing : declared > found ? [found] : [];
  const extra = Math.max(0, declared - found - gaps.length);
  const number: number[] = [];
  const lost: number[] = [];
  let n = 0;
  let g = 0;
  for (let i = 0; i <= found; i++) {
    for (; g < gaps.length && gaps[g] <= i; g++) {
      const size = 1 + (g === gaps.length - 1 ? extra : 0);
      for (let k = 0; k < size; k++) lost.push(++n);
    }
    if (i < found) number.push(++n);
  }
  return { number, lost };
}

export async function repairPdf(file: Blob, opts: RepairOptions = {}): Promise<{ bytes: Uint8Array; report: RepairReport }> {
  const { signal } = opts;
  const progress = opts.progress ?? (() => {});
  const rebuilt = await rebuildFile(file, (f, label) => progress(f * 0.4, label), signal);
  stopIfAborted(signal);

  if (rebuilt.kind === "done") {
    const pages = rebuilt.slots.length;
    const { lost } = originalNumbers(pages, rebuilt.missing, rebuilt.declared);
    return {
      bytes: rebuilt.bytes,
      report: {
        pages,
        of: rebuilt.declared,
        pictures: [],
        searchable: [],
        partial: rebuilt.slots.flatMap((s, i) => (s.partial ? [i + 1] : [])),
        lost,
        fixes: rebuilt.fixes,
        before: rebuilt.before,
        after: rebuilt.after,
      },
    };
  }

  if (rebuilt.kind === "unread") {
    // pdf-lib couldn't read it: every page pdf.js can draw becomes a picture.
    const loaded = await openForPictures([async () => rebuilt.bytes, async () => new Uint8Array(await file.arrayBuffer())], rebuilt.encrypted);
    const count = loaded.numPages;
    const before = await loaded.extras().catch(() => ({ bookmarks: 0, fields: 0 }));
    const drawn = await pictures(loaded, Array.from({ length: count }, (_, i) => i + 1), opts, 0.4, 0.98);
    if (!drawn.bytes) throw new NothingRecoveredError();
    const pages = drawn.made.length;
    return {
      bytes: drawn.bytes,
      report: {
        pages,
        of: count,
        pictures: drawn.made.map((_, k) => k + 1),
        searchable: drawn.made.flatMap((m, k) => (m.text ? [k + 1] : [])),
        partial: [],
        lost: drawn.failed,
        fixes: rebuilt.fixes,
        before,
        after: { bookmarks: 0, fields: 0 },
      },
    };
  }

  // Some pages copied as they were, the rest drawn.
  const { slots } = rebuilt;
  const bad = slots.flatMap((s, i) => (s.kind === "picture" ? [i] : []));
  const loaded = await openForPictures([async () => rebuilt.render]);
  const drawn = await pictures(loaded, rebuilt.renderPages, opts, 0.4, 0.9);
  // Back from pages of `render` to places in the document.
  const placeOf = new Map(rebuilt.renderPages.map((page, k) => [page, bad[k]]));
  const made = new Map(drawn.made.map((m) => [placeOf.get(m.page)!, m]));
  const shown = slots.some((s, i) => (s.kind === "vector" && s.shows) || made.has(i));
  if (!shown) throw new NothingRecoveredError();
  progress(0.9, "Putting the pages together…");
  const placed = bad.filter((i) => made.has(i));
  const empty = bad.filter((i) => !made.has(i));
  const spliced = await spliceFile(rebuilt.vector, drawn.bytes, placed, empty, signal);

  const original = originalNumbers(slots.length, rebuilt.missing, rebuilt.declared);
  // Numbers in the repaired file, where the pages left out are gone.
  const gone = new Set(empty);
  const position = new Map<number, number>();
  slots.forEach((_, i) => !gone.has(i) && position.set(i, position.size + 1));
  return {
    bytes: spliced.bytes,
    report: {
      pages: spliced.pages,
      of: rebuilt.declared,
      pictures: placed.map((i) => position.get(i)!),
      searchable: placed.filter((i) => made.get(i)!.text).map((i) => position.get(i)!),
      partial: slots.flatMap((s, i) => (s.partial && position.has(i) ? [position.get(i)!] : [])),
      lost: [...original.lost, ...empty.map((i) => original.number[i])].sort((a, b) => a - b),
      fixes: rebuilt.fixes,
      before: rebuilt.before,
      after: spliced.after,
    },
  };
}

/** "3", "2 and 5", "1–4, 7 and 9". */
export function pageList(pages: number[]): string {
  const items: string[] = [];
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    // Three or more in a row read as a range.
    if (j - i >= 2) items.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k++) items.push(String(sorted[k]));
    i = j + 1;
  }
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

const pagesWord = (pages: number[]) => `${pages.length === 1 ? "Page" : "Pages"} ${pageList(pages)}`;

const FIXED: Record<Exclude<Fix, "end-lost">, string> = {
  "junk-before": "removed data in front of the PDF",
  "junk-after": "removed data after its end",
  "cut-off": "closed a file that was cut off",
  header: "added its missing start",
  index: "rebuilt its broken index",
  objects: "recovered objects from a damaged compressed part",
  pages: "rebuilt its page list",
  count: "corrected its page count",
};

export interface ReportLine {
  text: string;
  /** Something was lost or changed that the person should know about. */
  warn?: boolean;
}

/** The report in short plain lines, good news first. */
export function repairLines(r: RepairReport): ReportLine[] {
  const lines: ReportLine[] = [];
  const clean =
    !r.fixes.length && !r.pictures.length && !r.partial.length && !r.lost.length && r.pages === r.of &&
    r.after.fields >= r.before.fields && r.after.bookmarks >= r.before.bookmarks;
  if (clean) return [{ text: `No damage found: all ${r.pages} page${r.pages === 1 ? " is" : "s are"} as ${r.pages === 1 ? "it was" : "they were"}.` }];

  lines.push(
    r.pages === r.of
      ? { text: r.pages === 1 ? "Recovered the page." : `Recovered all ${r.pages} pages.` }
      : { text: `Recovered ${r.pages} of ${r.of} pages.`, warn: true }
  );
  const fixed = r.fixes.filter((f): f is Exclude<Fix, "end-lost"> => f !== "end-lost");
  if (fixed.length) {
    const parts = fixed.map((f) => FIXED[f]);
    const joined = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
    lines.push({ text: `Fixed: ${joined}.` });
  }
  if (r.pictures.length) {
    const one = r.pictures.length === 1;
    const all = r.searchable.length === r.pictures.length;
    const tail = all
      ? `; ${one ? "its" : "their"} text can still be searched`
      : !r.searchable.length
        ? `; ${one ? "it has" : "they have"} no text to search`
        : `; the text of ${pagesWord(r.searchable).toLowerCase()} can still be searched`;
    lines.push({ text: `${pagesWord(r.pictures)} ${one ? "is a picture" : "are pictures"} now${tail}.`, warn: true });
  }
  if (r.partial.length) {
    const one = r.partial.length === 1;
    lines.push({ text: `${pagesWord(r.partial)} ${one ? "was" : "were"} cut off: only the start of ${one ? "it" : "them"} is there.`, warn: true });
  }
  if (r.lost.length) {
    const one = r.lost.length === 1;
    lines.push({ text: `${pagesWord(r.lost)} of the original couldn't be read and ${one ? "is" : "are"} left out.`, warn: true });
  }
  if (r.fixes.includes("end-lost")) {
    lines.push({ text: "The end of the file was missing, so anything kept there, such as some fields, links or bookmarks, may be gone.", warn: true });
  }
  if (r.before.fields > r.after.fields) {
    lines.push({
      text: r.after.fields ? `${r.after.fields} of ${r.before.fields} form fields can still be filled in.` : "Its form fields were lost.",
      warn: true,
    });
  }
  if (r.before.bookmarks > r.after.bookmarks) {
    lines.push({ text: r.after.bookmarks ? "Some of its bookmarks were lost." : "Its bookmarks were lost.", warn: true });
  }
  return lines;
}
