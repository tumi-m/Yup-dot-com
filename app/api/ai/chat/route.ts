import { z } from "zod";
import { limitsFor } from "@/lib/limits";
import { resolveTier } from "@/lib/tier";
import { aiRemaining, claimAiAnswer, usageSubject } from "@/lib/usage";
import { ollamaConfig, streamChat, userMessage, OllamaError, type ChatMessage } from "@/lib/ai/ollama";
import { fitDocument } from "@/lib/ai/document";

/**
 * Chat with / summarize a PDF. Open to guests with a small daily allowance,
 * so people can try it before being asked to sign up.
 *
 * The browser parses the PDF (lib/pdf/parse.ts) and sends page-tagged text,
 * so the file itself is never uploaded. The model runs on Ollama (Ollama
 * Cloud by default; see lib/ai/ollama.ts). The document always comes first
 * in the conversation, unchanged between turns, so providers that cache
 * prompt prefixes can reuse it for follow-up questions.
 *
 * Responds with newline-delimited JSON events:
 *   {"type":"text","text":"..."} · {"type":"done","stopReason":"..."} · {"type":"error","message":"..."}
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_TURNS = 40;

const bodySchema = z.object({
  documentName: z.string().max(300),
  documentText: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      })
    )
    .min(1)
    .max(MAX_TURNS),
});

// Stable across every request so the cached prefix is never invalidated.
const SYSTEM = `You are the document assistant inside PDF Wizard. The user has shared one PDF; its text is provided in <document> tags, split into pages marked [Page N].

Answer only from the document. When you state a fact from it, cite the page like (p. 3). If the document does not contain the answer, say so plainly instead of guessing. The text was machine-extracted, so tables may appear as rows of cells and some formatting is lost.

Be direct and concise. Use short paragraphs and bullet lists where they help; use Markdown.`;

/**
 * Allowances (lib/usage.ts, env-overridable): answers per day per tier, a
 * monthly cap on Pro, a per-minute burst and a site-wide daily cap. Counted
 * in Supabase, so every server instance sees the same numbers. Guests are
 * keyed by a salted hash of their IP, account holders by user id.
 */

function json(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const config = ollamaConfig();
  if (!config) {
    console.error("AI assistant disabled: set OLLAMA_API_KEY (Ollama Cloud) or OLLAMA_HOST (your own server).");
    return json(503, "The AI assistant isn't configured on this deployment yet.");
  }

  const { user, tier } = await resolveTier();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, "Invalid request.");
  const { documentName, documentText, messages } = parsed.data;

  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") {
    return json(400, "Conversation must start and end with a user message.");
  }

  // Long documents are cut at a page boundary to the plan's budget, and the
  // model is told which pages it has, so answers stay honest about coverage.
  const fitted = fitDocument(documentText, limitsFor(tier).aiDocumentChars);

  // Count only requests that will actually reach the model.
  const claim = await claimAiAnswer(usageSubject(request, user), tier);
  if (!claim.ok) {
    return Response.json(
      { error: claim.error, upgrade: !!claim.upgrade, reason: claim.reason },
      { status: claim.status, headers: { "Cache-Control": "no-store" } }
    );
  }
  const remaining = claim.remaining;

  const coverage = fitted.truncated
    ? fitted.lastPage && fitted.totalPages
      ? `\nOnly pages 1-${fitted.lastPage} of ${fitted.totalPages} are included. If the answer may be on a later page, say so.`
      : "\nOnly the beginning of the document is included. If the answer may be later in it, say so."
    : "";
  const apiMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM + coverage },
    ...messages.map((m, i): ChatMessage =>
      i === 0
        ? {
            role: "user",
            content: `<document name="${documentName.replace(/[<>"]/g, "'")}">\n${fitted.text}\n</document>\n\n${m.content}`,
          }
        : { role: m.role, content: m.content }
    ),
  ];

  const encoder = new TextEncoder();
  const started = Date.now();

  const body = new ReadableStream({
    async start(controller) {
      let delivered = false;
      const send = (event: Record<string, unknown>) => {
        if (event.type === "text") delivered = true;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const stream = streamChat(
          config,
          { messages: apiMessages, maxAnswerTokens: 4000 },
          // Leave time to close the stream cleanly before maxDuration.
          { signal: request.signal, deadline: started + (maxDuration - 8) * 1000 }
        );
        let result = await stream.next();
        while (!result.done) {
          send({ type: "text", text: result.value });
          result = await stream.next();
        }
        if (result.value.doneReason === "length") {
          send({ type: "error", message: "The answer was cut short. Ask a narrower question." });
        }
        send({ type: "done", stopReason: result.value.doneReason });
      } catch (error) {
        if (!(error instanceof OllamaError) || (error.kind !== "aborted" && error.kind !== "rate_limit")) {
          console.error("ai/chat error:", error instanceof Error ? error.message : error);
        }
        // An answer that never arrived shouldn't cost the user a turn.
        if (!delivered) await claim.refund().catch(() => {});
        try {
          send({ type: "error", message: userMessage(error) });
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
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "x-ai-remaining": String(remaining),
      ...(fitted.truncated && fitted.lastPage && fitted.totalPages
        ? { "x-ai-pages": `${fitted.lastPage}/${fitted.totalPages}` }
        : {}),
    },
  });
}

/** Answers left today, for the "N left today" label before the first question. */
export async function GET(request: Request) {
  if (!ollamaConfig()) return Response.json({ remaining: null }, { headers: { "Cache-Control": "no-store" } });
  const { user, tier } = await resolveTier();
  const remaining = await aiRemaining(usageSubject(request, user), tier).catch(() => null);
  return Response.json({ remaining }, { headers: { "Cache-Control": "no-store" } });
}
