/**
 * The tool that can help after an error, if one can: Repair PDF for a file
 * that won't read, Unlock PDF for a locked one. Never the page that failed.
 */
import { UNREADABLE_MESSAGE } from "@/lib/pdf/errors";

export function helpFor(message: string | null, slug: string): { slug: string; label: string } | null {
  if (!message) return null;
  if (message.endsWith(UNREADABLE_MESSAGE) && slug !== "repair-pdf") return { slug: "repair-pdf", label: "Try Repair PDF" };
  if (/password-protected/i.test(message) && slug !== "unlock-pdf") return { slug: "unlock-pdf", label: "Unlock PDF" };
  return null;
}
