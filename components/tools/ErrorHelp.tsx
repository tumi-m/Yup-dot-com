"use client";

import { useRouter } from "next/navigation";
import { fileToHandoff, tryHandoff } from "@/lib/local-store";
import { errorFix } from "./file-pick";

/**
 * An error message, with a button after it to the tool that fixes it when
 * one can (errorFix: Repair, Unlock or OCR PDF). The file the message is
 * about goes with it, so it opens already chosen.
 */
export function ErrorHelp({
  message,
  slug,
  files,
  onLeave,
}: {
  message: string;
  slug: string;
  files: File[];
  /** Runs before the page is left, e.g. to cancel a pending prompt. */
  onLeave?: () => void;
}) {
  const router = useRouter();
  const fix = errorFix(message, files, slug);
  if (!fix) return <>{message}</>;

  async function go(to: { slug: string; file: File }) {
    onLeave?.();
    // Without room to hand it over, the tool still opens, ready for the file.
    const handed = await tryHandoff([fileToHandoff(to.file, to.file.name)]);
    router.push(handed ? `/tools/${to.slug}?handoff=1` : `/tools/${to.slug}`);
  }

  // In the text, so on a phone it wraps under the message instead of squeezing it.
  return (
    <>
      {message}{" "}
      <button
        type="button"
        onClick={() => void go(fix)}
        className="tap whitespace-nowrap rounded font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="error-help"
      >
        {fix.label}
      </button>
    </>
  );
}
