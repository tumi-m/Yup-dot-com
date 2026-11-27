import { handleOfficeRefund } from "@/lib/office-server";
import { resolveTier } from "@/lib/tier";

/**
 * Word and Excel to PDF: gives a conversion back when the worker says it
 * failed or never ran. See lib/office-server.ts.
 */

export const runtime = "nodejs";
export const maxDuration = 20;

export function POST(request: Request) {
  return handleOfficeRefund(request, { resolveTier });
}
