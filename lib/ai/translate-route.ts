/**
 * POST /api/ai/translate: translates one request of passages for
 * Translate PDF. GET: whether translation runs here and the visitor's
 * characters left today.
 *
 * As /api/ai/chat: other sites' pages are refused, guests get a small daily
 * allowance and account holders their plan's, counted on the server (lib/
 * usage.ts) before the model is asked, with a per-minute burst and a
 * site-wide daily cap; a request that delivered nothing is given back (a
 * few a day). The browser parses the PDF and sends only its text, a page's
 * worth at a time; nothing is stored, and the text is never logged.
 *
 * Responds with newline-delimited JSON (lib/translate/format.ts):
 *   {"type":"segment","id":"..","text":".."} · {"type":"missing","ids":[..]} · {"type":"done"} · {"type":"error","message":".."}
 */
import "server-only";
import { z } from "zod";
import { refuseCrossSite } from "../cross-site";
import type { Tier } from "../limits";
import { claimTranslation, translatePolicy, translationRemaining, usageSubject, type UsageStore } from "../usage";
import { OllamaError, type OllamaConfig } from "./ollama";
import { translateBatch, translateMessage } from "./translate";
import { languageByCode } from "../translate/languages";
import { CHARGE_UNIT, MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS, MAX_SEGMENT_CHARS, SEGMENT_ID, type TranslateEvent, type TranslateStatus } from "../translate/format";

export const TRANSLATE_UNAVAILABLE = "Translation isn't available right now.";

export interface TranslateDeps {
  config: () => OllamaConfig | null;
  resolveTier: () => Promise<{ user: { id: string } | null; tier: Tier }>;
  /** Tests: a usage store of their own. */
  store?: UsageStore;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The route's maxDuration; answers stop a few seconds before it. */
  maxDurationSeconds?: number;
}

const bodySchema = z.object({
  target: z.string().max(20),
  source: z.string().max(20).optional(),
  segments: z
    .array(z.object({ id: z.string().regex(SEGMENT_ID), text: z.string().min(1).max(MAX_SEGMENT_CHARS) }))
    .min(1)
    .max(MAX_BATCH_SEGMENTS),
});

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, error: string) {
  return Response.json({ error }, { status, headers: NO_STORE });
}

export async function handleTranslate(request: Request, deps: TranslateDeps): Promise<Response> {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const config = deps.config();
  if (!config) {
    console.error("Translate PDF disabled: set OLLAMA_API_KEY (Ollama Cloud) or OLLAMA_HOST (your own server).");
    return json(503, TRANSLATE_UNAVAILABLE);
  }

  const { user, tier } = await deps.resolveTier();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, "Invalid request.");
  const { segments } = parsed.data;
  const target = languageByCode(parsed.data.target);
  const auto = !parsed.data.source || parsed.data.source === "auto";
  const source = auto ? null : (languageByCode(parsed.data.source) ?? null);
  if (!target || (!auto && !source)) return json(400, "Unknown language.");
  if (new Set(segments.map((s) => s.id)).size !== segments.length) return json(400, "Invalid request.");
  const chars = segments.reduce((n, s) => n + s.text.length, 0);
  if (chars > MAX_BATCH_CHARS) return json(400, "Invalid request.");

  // Counted only once the request will reach the model.
  const claim = await claimTranslation(usageSubject(request, user), tier, chars, CHARGE_UNIT, { store: deps.store, env: deps.env });
  if (!claim.ok) {
    return Response.json({ error: claim.error, upgrade: !!claim.upgrade, reason: claim.reason }, { status: claim.status, headers: NO_STORE });
  }

  const encoder = new TextEncoder();
  const started = Date.now();
  const maxDuration = deps.maxDurationSeconds ?? 120;

  const body = new ReadableStream({
    async start(controller) {
      let delivered = false;
      const send = (event: TranslateEvent) => {
        if (event.type === "segment") delivered = true;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const events = translateBatch(
          config,
          { segments, target, source },
          // Leave time to close the stream cleanly before maxDuration.
          { signal: request.signal, deadline: started + (maxDuration - 8) * 1000, fetch: deps.fetch }
        );
        for await (const event of events) send(event);
        // Nothing usable came back: that costs nothing (up to a few a day).
        if (!delivered) await claim.refund().catch(() => {});
        send({ type: "done" });
      } catch (error) {
        // The model's or the connection's message only; never the document's text.
        if (!(error instanceof OllamaError) || (error.kind !== "aborted" && error.kind !== "rate_limit")) {
          console.error("ai/translate error:", error instanceof Error ? error.message : error);
        }
        if (!delivered) await claim.refund({ unsent: error instanceof OllamaError && error.unsent }).catch(() => {});
        try {
          send({ type: "error", message: translateMessage(error) });
        } catch {
          // The browser already hung up.
        }
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", ...NO_STORE, "x-translate-remaining": String(claim.remaining) },
  });
}

/** Whether translation runs here, and the visitor's characters left today. */
export async function handleTranslateStatus(request: Request, deps: TranslateDeps): Promise<Response> {
  const none: TranslateStatus = { available: false, remaining: null, limit: null };
  if (!deps.config()) return Response.json(none, { headers: NO_STORE });
  const { user, tier } = await deps.resolveTier();
  const subject = usageSubject(request, user);
  const remaining = await translationRemaining(subject, tier, CHARGE_UNIT, { store: deps.store, env: deps.env }).catch(() => null);
  const status: TranslateStatus = { available: true, remaining, limit: translatePolicy(tier, deps.env).day };
  return Response.json(status, { headers: NO_STORE });
}
