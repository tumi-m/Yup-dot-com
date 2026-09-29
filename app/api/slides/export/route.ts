import { handleSlidesExport } from "@/lib/google-slides";
import { clientIp, consumeDaily } from "@/lib/quota";
import { resolveTier } from "@/lib/tier";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Streams a Google Slides deck (shared by link) as PDF or PPTX. */
export function GET(request: Request) {
  return handleSlidesExport(request, { resolveTier, consumeDaily, clientIp });
}
