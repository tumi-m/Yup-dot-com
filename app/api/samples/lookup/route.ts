import { handleLookup } from "@/lib/samples/handlers";
import { resolveTier } from "@/lib/tier";
import { usageSubject } from "@/lib/usage";
import { refuseCrossSite } from "@/lib/cross-site";

export const runtime = "nodejs";
export const maxDuration = 30;

/** A song's samples, the songs that sampled it, covers and remixes. */
export function POST(request: Request) {
  // Spends one of the visitor's daily lookups: only this site's pages may ask.
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  return handleLookup(request, { resolveTier, usageSubject });
}
