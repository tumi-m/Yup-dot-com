import { handleOfficeLink } from "@/lib/office-server";
import { resolveTier } from "@/lib/tier";

/**
 * Word and Excel to PDF: authorises one upload to the media worker for a
 * file of this size and type, after the plan's size limit and the daily
 * allowance. See lib/office-server.ts.
 */

export const runtime = "nodejs";
export const maxDuration = 20;

export function POST(request: Request) {
  return handleOfficeLink(request, { resolveTier });
}
