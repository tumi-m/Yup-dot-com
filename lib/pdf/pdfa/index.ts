/**
 * PDF to PDF/A: an archival copy of a PDF, made in the browser.
 *
 * The pdf-lib work runs in a worker (convert.ts, off-thread.ts). Pages that
 * can't be put right in place, such as those drawn with a font that can't
 * be embedded, are drawn here by pdf.js as pictures with their text kept
 * searchable (pictures.ts), then put in their places. The result is checked
 * again against the rules this tool puts right (check.ts), and the report
 * says what was done, what changed and what our check found.
 */
import { TooManyPixelsError } from "../raster";
import { stopIfAborted } from "../../abort";
import { finishFile, prepareFile } from "./off-thread";
import { drawPages, TOO_MANY } from "./pictures";
import type { PdfaResult } from "./convert";
import type { FontFiles } from "./fonts";
import type { Part } from "./metadata";
import type { CheckId } from "./check";

export { PasswordError, NEEDS_PASSWORD, WRONG_PASSWORD } from "./convert";
export type { PdfaResult } from "./convert";

export interface PdfaOptions {
  part: Part;
  password?: string;
  progress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
  /** A fresh canvas; Node tests pass node-canvas. */
  canvas?: () => HTMLCanvasElement;
  /** Substitute font files; Node tests read them from node_modules. Given, everything runs on this thread. */
  fonts?: FontFiles;
}

export async function convertToPdfa(file: Blob, opts: PdfaOptions): Promise<PdfaResult> {
  const progress = opts.progress ?? (() => {});
  const prepared = await prepareFile(file, { part: opts.part, password: opts.password, fonts: opts.fonts }, (f, l) => progress(f * 0.6, l), opts.signal);
  if (prepared.kind === "done") return prepared.result;
  stopIfAborted(opts.signal);
  let pictures: Uint8Array;
  try {
    pictures = await drawPages(prepared.vector, prepared.pages, { progress: (f, l) => progress(0.6 + f * 0.3, l), signal: opts.signal, canvas: opts.canvas });
  } catch (err) {
    if (err instanceof TooManyPixelsError) throw new Error(TOO_MANY);
    throw err;
  }
  return finishFile(prepared.vector, pictures, prepared.facts, (f, l) => progress(Math.max(0.9, f), l), opts.signal);
}

/** "3", "2 and 5", "1–4, 7 and 9". */
export function pageList(pages: number[]): string {
  const items: string[] = [];
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) items.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k++) items.push(String(sorted[k]));
    i = j + 1;
  }
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");
}

const pagesWord = (pages: number[]) => `${pages.length === 1 ? "page" : "pages"} ${pageList(pages)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ReportLine {
  text: string;
  warn?: boolean;
}

const CHECK_LABELS: Record<CheckId, string> = {
  file: "File structure",
  metadata: "Metadata (XMP)",
  colour: "Colour profile",
  fonts: "Embedded fonts",
  actions: "No scripts or forbidden actions",
  attachments: "Attachments",
  annotations: "Comments and links",
  forms: "Form fields",
  content: "Page content and pictures",
};

/** The report in short plain lines: our check first, then what changed. */
export function pdfaLines(result: PdfaResult): ReportLine[] {
  const { facts, checks } = result;
  const lines: ReportLine[] = [];
  const name = `PDF/A-${facts.part}b`;
  for (const c of checks) {
    lines.push(
      c.ok
        ? { text: `${CHECK_LABELS[c.id]}: OK` }
        : { text: `${CHECK_LABELS[c.id]}: not met. ${c.problem}${c.pages?.length ? ` (${pagesWord(c.pages)})` : ""}`, warn: true }
    );
  }
  if (facts.pictures.length) {
    const pages = facts.pictures.map((p) => p.page + 1);
    const fonts = [...new Set(facts.pictures.map((p) => p.font).filter(Boolean))];
    const why = fonts.length ? `: ${fonts.length === 1 ? "a font" : "fonts"} that can't be embedded (${fonts.slice(0, 3).join(", ")})` : "";
    lines.push({ text: `Rebuilt as pictures: ${pagesWord(pages)}${why}. ${pages.length === 1 ? "Its" : "Their"} text can still be searched and copied.`, warn: true });
  }
  if (facts.substituted.length) {
    const list = facts.substituted.slice(0, 4).map((s) => `${s.from} as ${s.to}`).join(", ");
    lines.push({ text: `Fonts embedded with the same letter widths: ${list}${facts.substituted.length > 4 ? ", and more" : ""}.` });
  }
  lines.push({ text: facts.intent === "srgb" ? "Colour: the sRGB profile was added." : "Colour: the file's own colour profile was kept." });
  if (facts.encrypted) lines.push({ text: "The password and its limits were removed: PDF/A files can't be encrypted.", warn: true });
  const o = facts.objects;
  const removed = [
    o.scripts && plural(o.scripts, "script"),
    o.actions && plural(o.actions, "action") + " that launch, submit or play",
    (o.attachments || facts.annotations.attachments) && plural(o.attachments + facts.annotations.attachments, "attached file"),
    facts.annotations.media && plural(facts.annotations.media, "sound, video or 3D item"),
    facts.annotations.hidden && plural(facts.annotations.hidden, "hidden comment"),
    facts.annotations.blank && plural(facts.annotations.blank, "comment with nothing to show", "comments with nothing to show"),
  ].filter(Boolean);
  if (removed.length) {
    const tail = facts.part === 2 && (o.attachments || facts.annotations.attachments) ? ` PDF/A-3b keeps attached files.` : "";
    lines.push({ text: `Removed, as ${name} asks: ${removed.join(", ")}.${tail}`, warn: true });
  }
  if (facts.fields) lines.push({ text: `${plural(facts.fields, "form field")} made part of the page.` });
  if (facts.signatures) lines.push({ text: "A changed copy can't keep a digital signature valid: its look stays on the page.", warn: true });
  if (facts.claimed) lines.push({ text: `The file said it was ${facts.claimed} before; it was checked and written again as ${name}.` });
  lines.push({ text: "This is our own check of the rules above, not a certified validator. For formal proof, check the file with the free veraPDF validator (verapdf.org)." });
  return lines;
}
