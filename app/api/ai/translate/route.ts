import { translateConfig } from "@/lib/ai/ollama";
import { handleTranslate, handleTranslateStatus } from "@/lib/ai/translate-route";
import { resolveTier } from "@/lib/tier";

/**
 * Translate PDF's passages, a request at a time, streamed back as NDJSON.
 * See lib/ai/translate-route.ts (checks, allowance, events) and
 * lib/ai/translate.ts (the prompt and how answers are checked).
 */

export const runtime = "nodejs";
export const maxDuration = 120;

export function POST(request: Request) {
  return handleTranslate(request, { config: translateConfig, resolveTier, maxDurationSeconds: maxDuration });
}

/** Whether translation runs here, and the visitor's own characters left today. */
export function GET(request: Request) {
  return handleTranslateStatus(request, { config: translateConfig, resolveTier });
}
