/**
 * Parse errors and their messages, kept apart from the parser so a page can
 * report a failure even when the parser's own code didn't load.
 */
import { isLoadError, loadErrorMessage } from "../load-error";

export class PptxError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "legacy" | "encrypted" | "empty"
  ) {
    super(message);
    this.name = "PptxError";
  }
}

export const PPTX_MESSAGES = {
  invalid: "This file isn't a valid .pptx.",
  legacy: "Save it as .pptx first.",
  encrypted: "This file is password-protected. Remove the password first.",
  empty: "This presentation has no slides.",
} as const;

/** A short, user-facing message for any error thrown while parsing. */
export function pptxErrorMessage(err: unknown): string {
  if (isLoadError(err)) return loadErrorMessage();
  return err instanceof PptxError ? err.message : PPTX_MESSAGES.invalid;
}
