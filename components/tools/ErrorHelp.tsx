"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { fileToHandoff, tryHandoff } from "@/lib/local-store";
import { helpFor } from "./error-help";

/**
 * A link after an error to the tool that can help (error-help.ts). The file
 * goes with it when the browser can keep it, so it opens already chosen.
 */
export function ErrorHelp({ message, slug, file }: { message: string | null; slug: string; file?: File | null }) {
  const router = useRouter();
  const help = helpFor(message, slug);
  if (!help) return null;
  const href = `/tools/${help.slug}`;
  return (
    <Link
      href={href}
      onClick={(e) => {
        if (!file || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        void tryHandoff([fileToHandoff(file)]).then((ok) => router.push(ok ? `${href}?handoff=1` : href));
      }}
      className="shrink-0 rounded font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:py-2.5"
      data-testid="error-help"
    >
      {help.label}
    </Link>
  );
}
