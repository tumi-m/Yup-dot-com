/**
 * A text file's bytes as clean text: UTF-8 (with or without a BOM), UTF-16
 * with a BOM, or else Windows-1252, the usual encoding of older Windows
 * files. Line endings become \n, tabs become spaces to the next stop, and
 * control characters other than a form feed (a page break) are dropped.
 */

/** Files with NUL bytes and no UTF-16 mark aren't text (a PDF, a picture, a zip renamed .txt). */
export const NOT_TEXT = "this doesn't look like a text file.";

export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const head = bytes.subarray(start, start + 8192);
  if (head.includes(0)) throw new Error(NOT_TEXT);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
  } catch {
    return new TextDecoder("windows-1252").decode(bytes.subarray(start));
  }
}

/** Expands tabs to stops every `tab` columns, counting characters as people see them. */
export function expandTabs(line: string, tab = 4): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const ch of line) {
    if (ch === "\t") {
      const n = tab - (col % tab);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

/**
 * Text ready to lay out: NFC (an accent typed as a separate mark joins its
 * letter, so one font draws both), \n line ends, no control characters but
 * \n, \t and \f.
 */
export function cleanText(text: string): string {
  return (
    text
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      // C0 and C1 controls, and the BOM or other invisible format marks left mid-text.
      .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f﻿￹-￻]/g, "")
  );
}
