import { workerConfig } from "@/lib/media-server";
import { resolveTier } from "@/lib/tier";
import { HTML_TO_PDF_ENABLED } from "@/lib/web-pdf";
import { handleWebPdfLink } from "@/lib/web-pdf-route";

/**
 * A short-lived grant for one PDF of a web page, an HTML file or pasted
 * HTML, which the browser hands to the media worker. See
 * lib/web-pdf-route.ts (checks, allowance, what the grant names) and
 * media-worker/render.py (what the worker allows the page to reach).
 */

export const runtime = "nodejs";
export const maxDuration = 15;

export function POST(request: Request) {
  return handleWebPdfLink(request, { enabled: HTML_TO_PDF_ENABLED, config: workerConfig, resolveTier });
}
