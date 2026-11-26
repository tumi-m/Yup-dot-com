/**
 * The comparison report: a PDF listing every change with its pages and the
 * words before and after, written as Markdown and laid out by Markdown to
 * PDF (embedded Noto Sans, so accented and Greek or Cyrillic text prints).
 */
import { markdownToPdf } from "../text-to-pdf/markdown";
import type { FontFiles } from "../text-to-pdf/fonts";
import type { CompareResult } from "./index";
import { KIND_LABEL } from "./view";

/** A long run of words is cut short in the report; the marked PDFs show all of it. */
const MAX_CELL = 400;
/** More changes than this are left out of the report, and it says so. */
export const MAX_LISTED = 5000;

const plural = (n: number, word: string, words = `${word}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? word : words}`;

/** Text from the files, safe in Markdown: every sign escaped, so nothing in it is read as formatting. */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_{}[\]()#+\-.!|<>~&"'=:^$]/g, "\\$&");
}

const cell = (text: string) => {
  const short = [...text].length > MAX_CELL ? `${[...text].slice(0, MAX_CELL).join("")}…` : text;
  return escapeMarkdown(short);
};

/** "Pages 2, 3 and 5" */
export function pageList(pages: number[]): string {
  const n = pages.map((p) => String(p + 1));
  const list = n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n[0];
  return `${n.length === 1 ? "Page" : "Pages"} ${list}`;
}

/** The words of a summary line: "3 changes: 1 changed, 1 added, 1 removed". */
export function summaryLine(r: CompareResult): string {
  const s = r.summary;
  if (!s.changes && !s.pagesAdded.length && !s.pagesRemoved.length) return "No differences found.";
  const parts = [
    s.changed && `${s.changed.toLocaleString("en-US")} changed`,
    s.added && `${s.added.toLocaleString("en-US")} added`,
    s.removed && `${s.removed.toLocaleString("en-US")} removed`,
    s.moved && `${s.moved.toLocaleString("en-US")} moved`,
    s.pictures && `${plural(s.pictures, "picture")} that look${s.pictures === 1 ? "s" : ""} different`,
  ].filter(Boolean);
  return `${plural(s.changes, "change")}${parts.length ? `: ${parts.join(", ")}` : ""}.`;
}

/** "p. 2" where the change shows in a file, or nothing where that file has none of it. */
const pageOf = (n: number | null, has: boolean) => (n === null || !has ? "" : `p. ${n + 1}`);

export function reportMarkdown(r: CompareResult, names: { a: string; b: string; pagesA: number; pagesB: number }, date: string): string {
  const s = r.summary;
  const out: string[] = [];
  out.push(`# Comparison of ${escapeMarkdown(names.a)} and ${escapeMarkdown(names.b)}`, "");
  out.push(`**Original:** ${escapeMarkdown(names.a)}, ${plural(names.pagesA, "page")}  `);
  out.push(`**Changed version:** ${escapeMarkdown(names.b)}, ${plural(names.pagesB, "page")}  `);
  out.push(`Compared on ${escapeMarkdown(date)} with PDF Wizard, in the browser.`, "");
  out.push("## Summary", "");
  out.push(`- ${escapeMarkdown(summaryLine(r))}`);
  if (s.wordsAdded || s.wordsRemoved) out.push(`- ${plural(s.wordsAdded, "word")} added, ${plural(s.wordsRemoved, "word")} taken out.`);
  if (s.pagesAdded.length) out.push(`- ${pageList(s.pagesAdded)} of the changed version ${s.pagesAdded.length === 1 ? "is" : "are"} new.`);
  if (s.pagesRemoved.length) out.push(`- ${pageList(s.pagesRemoved)} of the original ${s.pagesRemoved.length === 1 ? "is" : "are"} gone from the changed version.`);
  if (r.scanned.a.length || r.scanned.b.length) {
    const side = (pages: number[], name: string) => (pages.length ? `${pageList(pages)} of the ${name}` : "");
    const list = [side(r.scanned.a, "original"), side(r.scanned.b, "changed version")].filter(Boolean).join("; ");
    out.push(`- No text on ${list.charAt(0).toLowerCase()}${list.slice(1)}: compared by how they look.`);
  }
  if (r.coarse) out.push("- These files differ a lot, so lines were lined up before words.");
  out.push("");
  if (!r.changes.length) return out.join("\n");
  out.push("## Changes", "");
  out.push("| # | What | Page | Original | Page | Changed version |", "| --- | --- | --- | --- | --- | --- |");
  r.changes.slice(0, MAX_LISTED).forEach((c, i) => {
    const picture = c.kind === "picture";
    const before = picture ? "See the page" : c.kind === "moved" ? cell(c.oldText) : c.oldText ? `~~${cell(c.oldText)}~~` : "";
    const after = picture ? "See the page" : c.kind === "moved" ? `Moved here: ${cell(c.newText)}` : cell(c.newText);
    const oldPage = pageOf(c.oldPage, picture || c.kind !== "added");
    const newPage = pageOf(c.newPage, picture || c.kind !== "removed");
    out.push(`| ${i + 1} | ${KIND_LABEL[c.kind]} | ${oldPage} | ${before} | ${newPage} | ${after} |`);
  });
  if (r.changes.length > MAX_LISTED) {
    out.push("", `The first ${MAX_LISTED.toLocaleString("en-US")} changes are listed; ${(r.changes.length - MAX_LISTED).toLocaleString("en-US")} more are marked in the PDFs.`);
  }
  return out.join("\n");
}

/** The report as a PDF. */
export async function makeReport(
  r: CompareResult,
  names: { a: string; b: string; pagesA: number; pagesB: number },
  date: string,
  fonts: FontFiles
): Promise<Uint8Array> {
  const md = reportMarkdown(r, names, date);
  const { bytes } = await markdownToPdf(new TextEncoder().encode(md), "Comparison report.md", { pageNumbers: "true", fontSize: "10", margin: "narrow" }, fonts);
  return bytes;
}
