/**
 * Turns low-level pdf-lib / pdf.js failures into short, human messages.
 * Library errors ("Failed to parse PDF document (line:0 col:0 offset=0)…",
 * "Input document to `PDFDocument.load` is encrypted…") must never reach users.
 */
import { isLoadError, loadErrorMessage } from "../load-error";

const ENCRYPTED = /is encrypted|PasswordException|No password given|Incorrect Password/i;
const UNREADABLE =
  /No PDF header|Invalid PDF structure|Failed to parse|size is zero bytes|PDF file is empty|Invalid object ref|InvalidPDFException|Expected instance of PDFDict|Missing PDF/i;

export const ENCRYPTED_MESSAGE = "This PDF is password-protected. Unlock it first.";
export const UNREADABLE_MESSAGE = "This file isn't a readable PDF.";

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
  if (name === "InvalidPDFException" || name === "TypeError" || UNREADABLE.test(message)) {
    return new Error(prefix + UNREADABLE_MESSAGE);
  }
  return err instanceof Error ? err : new Error("Something went wrong.");
}
