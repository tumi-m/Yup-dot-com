import { workerConfig } from "@/lib/media-server";
import { handleWebPdfRefund } from "@/lib/web-pdf-route";

/**
 * Gives a web page try back when the media worker says the page never loaded
 * (lib/web-pdf-route.ts says which failures count, and the daily cap).
 */

export const runtime = "nodejs";
export const maxDuration = 20;

export function POST(request: Request) {
  return handleWebPdfRefund(request, { config: workerConfig });
}
