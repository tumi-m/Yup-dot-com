/**
 * Turns low-level pdf-lib / pdf.js failures into short, human messages.
 * Library errors ("Failed to parse PDF document (line:0 col:0 offset=0)…",
 * "Input document to `PDFDocument.load` is encrypted…") must never reach users.
 */
import { isLoadError, loadErrorMessage } from "../load-error";

const ENCRYPTED = /is encrypted|PasswordException|No password given|Incorrect Password/i;
const UNREADABLE =
  /No PDF header|Invalid PDF structure|Failed to parse|size is zero bytes|PDF file is empty|Invalid object ref|InvalidPDFException|Expected instance of PDFDict|Missing PDF|circular reference|call stack|too much recursion/i;

export const ENCRYPTED_MESSAGE = "This PDF is password-protected. Unlock it first.";
export const UNREADABLE_MESSAGE = "This file isn't a readable PDF.";
export const LETTERS_MESSAGE = "Some of these letters can't be drawn in this PDF.";

export function friendlyPdfError(err: unknown, fileName?: string): Error {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const prefix = fileName ? `${fileName}: ` : "";
  // The tool's code didn't arrive (offline, flaky connection): the file is
  // fine. Asked before the TypeError check, since a failed fetch is one.
  if (isLoadError(err)) return new Error(loadErrorMessage());
  if (ENCRYPTED.test(name) || ENCRYPTED.test(message)) {
    return new Error(prefix + ENCRYPTED_MESSAGE);
  }
  // pdf-lib opens a file that has a header but no document after it, then
  // fails on the first page lookup with a TypeError ("Cannot read properties
  // of undefined (reading 'Pages')"). Never a message for people.
  // A page tree that holds itself sends pdf-lib round it until the stack
  // runs out (a RangeError); pdf.js says "Pages tree contains circular
  // reference." and wraps what it didn't expect as UnknownErrorException.
  const broken = ["InvalidPDFException", "UnknownErrorException", "TypeError", "RangeError"];
  if (broken.includes(name) || UNREADABLE.test(message)) {
    return new Error(prefix + UNREADABLE_MESSAGE);
  }
  // pdf-lib's standard fonts: "WinAnsi cannot encode "Ł" (0x0141)".
  if (/cannot encode/i.test(message)) return new Error(prefix + LETTERS_MESSAGE);
  return err instanceof Error ? err : new Error("Something went wrong.");
}
