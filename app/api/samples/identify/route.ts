import { handleIdentify } from "@/lib/samples/handlers";
import { resolveTier } from "@/lib/tier";
import { usageSubject } from "@/lib/usage";
import { refuseCrossSite } from "@/lib/cross-site";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Which song a YouTube or TikTok link, or some typed text, is. */
export function POST(request: Request) {
  // Each search makes this server call YouTube, TikTok or MusicBrainz: only
  // this site's pages may ask.
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  return handleIdentify(request, { resolveTier, usageSubject });
}
