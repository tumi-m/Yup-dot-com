import { z } from "zod";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { limitsFor, type Tier } from "@/lib/limits";
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
 * Daily answer allowance per tier. Guests are keyed by IP, account holders
 * by user id. In-memory, so it is per server instance — a cost backstop and
 * an upgrade moment, not a billing system. AI_GUEST_DAILY_LIMIT overrides
 * the guest allowance; set it to 0 to require an account for AI.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const usage = new Map<string, number[]>();

function dailyLimit(tier: Tier) {
  if (tier === "guest" && process.env.AI_GUEST_DAILY_LIMIT !== undefined) {
    return Math.max(0, Number(process.env.AI_GUEST_DAILY_LIMIT) || 0);
  }
  return limitsFor(tier).aiAnswersPerDay;
}

/** Returns answers remaining after this one, or -1 when the allowance is spent. */
function consume(key: string, limit: number) {
  const now = Date.now();
  const recent = (usage.get(key) ?? []).filter((t) => now - t < DAY_MS);
  if (recent.length >= limit) {
    usage.set(key, recent);
    return -1;
  }
  recent.push(now);
  usage.set(key, recent);
  return limit - recent.length;
}

/** Gives back a slot when a request failed before any answer was delivered. */
function refund(key: string) {
  const recent = usage.get(key);
  if (recent?.length) recent.pop();
}

function clientIp(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function json(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const config = ollamaConfig();
  if (!config) {
    console.error("AI assistant disabled: set OLLAMA_API_KEY (Ollama Cloud) or OLLAMA_HOST (your own server).");
    return json(503, "The AI assistant isn't configured on this deployment yet.");
  }

  const user = await getCurrentUser();
  const profile = user ? await getProfile().catch(() => null) : null;
  const tier: Tier = user ? (profile?.plan ?? "free") : "guest";
  const limit = dailyLimit(tier);
  if (tier === "guest" && limit === 0) return json(401, "Sign in to use the AI assistant.");

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
  const usageKey = user ? `u:${user.id}` : `ip:${clientIp(request)}`;
  const remaining = consume(usageKey, limit);
  if (remaining < 0) {
    return Response.json(
      { error: "You've used today's AI answers.", upgrade: tier !== "pro" && tier !== "team" },
      { status: 429 }
    );
  }

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
        if (!delivered) refund(usageKey);
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
