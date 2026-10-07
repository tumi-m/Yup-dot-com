/**
 * Turns low-level pdf-lib / pdf.js failures into short, human messages.
 * Library errors ("Failed to parse PDF document (line:0 col:0 offset=0)…",
 * "Input document to `PDFDocument.load` is encrypted…") must never reach users.
 */

const ENCRYPTED = /is encrypted|PasswordException|No password given|Incorrect Password/i;
const UNREADABLE =
  /No PDF header|Invalid PDF structure|Failed to parse|size is zero bytes|PDF file is empty|Invalid object ref|InvalidPDFException|Expected instance of PDFDict|Missing PDF/i;

export const ENCRYPTED_MESSAGE = "This PDF is password-protected. Unlock it first.";
export const UNREADABLE_MESSAGE = "This file isn't a readable PDF.";

export function friendlyPdfError(err: unknown, fileName?: string): Error {
  const name = (err as { name?: string })?.name ?? "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  const prefix = fileName ? `${fileName}: ` : "";
  if (ENCRYPTED.test(name) || ENCRYPTED.test(message)) {
    return new Error(prefix + ENCRYPTED_MESSAGE);
  }
  if (name === "InvalidPDFException" || UNREADABLE.test(message)) {
    return new Error(prefix + UNREADABLE_MESSAGE);
  }
  return err instanceof Error ? err : new Error("Something went wrong.");
}
