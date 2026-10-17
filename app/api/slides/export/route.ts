import { handleSlidesExport } from "@/lib/google-slides";
import { consumeDaily, usageSubject } from "@/lib/usage";
import { resolveTier } from "@/lib/tier";
import { refuseCrossSite } from "@/lib/cross-site";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Streams a Google Slides deck (shared by link) as PDF or PPTX. */
export function GET(request: Request) {
  // Each import counts against the visitor's daily allowance.
  const refused = refuseCrossSite(request, { json: false });
  if (refused) return refused;
  return handleSlidesExport(request, { resolveTier, consumeDaily, usageSubject });
}
