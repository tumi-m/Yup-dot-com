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
/** A PDF with no text to read: the page workbench offers OCR PDF next to it. */
export const SCANNED_MESSAGE = "This looks like a scanned PDF. Run OCR PDF on it first.";
export const NO_TABLES_MESSAGE = "No tables found in this PDF.";
/** The tab ran out of room for the file: nothing is wrong with it. */
export const MEMORY_MESSAGE = "This device ran out of memory for this file. Close other tabs and try again, or use a computer.";
/** The picked file is gone or changed (moved, deleted, a cloud file not downloaded). */
export const UNREAD_MESSAGE = "Couldn't read this file. Choose it again.";

// Engines when memory for an ArrayBuffer or array can't be had ("Array
// buffer allocation failed", "Out of memory"). Not "Invalid array length" or
// a negative typed array length, which a broken file's numbers cause, nor
// "Maximum call stack size exceeded", which is a looping file.
const OUT_OF_MEMORY = /allocation failed|out of memory/i;

/**
 * The browser couldn't hold or read the file, rather than the file being
 * broken: these must never send someone to Repair PDF.
 */
function deviceProblem(err: unknown): string | null {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (name === "NotReadableError" || name === "NotFoundError") return UNREAD_MESSAGE;
  if (name === "QuotaExceededError" || (name === "RangeError" && OUT_OF_MEMORY.test(message))) return MEMORY_MESSAGE;
  return null;
}

export function friendlyPdfError(err: unknown, fileName?: string): Error {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const prefix = fileName ? `${fileName}: ` : "";
  // The tool's code didn't arrive (offline, flaky connection): the file is
  // fine. Asked before the TypeError check, since a failed fetch is one.
  if (isLoadError(err)) return new Error(loadErrorMessage());
  const device = deviceProblem(err);
  if (device) return new Error(prefix + device);
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

/**
 * For tools that take pictures, text or video rather than PDFs: their own
 * messages already name the file, and a PDF message would be wrong. A
 * library's bare TypeError or RangeError still never reaches people.
 */
export function friendlyFileError(err: unknown): Error {
  if (isLoadError(err)) return new Error(loadErrorMessage());
  const device = deviceProblem(err);
  if (device) return new Error(device);
  const name = (err as { name?: string })?.name ?? "";
  if (name === "TypeError" || name === "RangeError" || !(err instanceof Error) || !err.message) {
    return new Error("Something went wrong with this file. Try again, or try another file.");
  }
  return err;
}
