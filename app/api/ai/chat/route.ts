import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { limitsFor, type Tier } from "@/lib/limits";

/**
 * Chat with / summarize a PDF. Open to guests with a small daily allowance,
 * so people can try it before being asked to sign up.
 *
 * The browser parses the PDF (lib/pdf/parse.ts) and sends page-tagged text,
 * so the file itself is never uploaded. The document is placed first in the
 * conversation behind a cache breakpoint: follow-up questions reuse it from
 * the prompt cache instead of paying for it again.
 *
 * Responds with newline-delimited JSON events:
 *   {"type":"text","text":"..."} · {"type":"done","stopReason":"..."} · {"type":"error","message":"..."}
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const MODEL = "claude-opus-5";
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
  if (!process.env.ANTHROPIC_API_KEY) {
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

  // Larger documents are rejected clearly rather than silently truncated,
  // which would produce confidently incomplete answers.
  const maxChars = limitsFor(tier).aiDocumentChars;
  if (documentText.length > maxChars) {
    return Response.json(
      {
        error: `This document is too long for your plan's assistant (${Math.round(documentText.length / 1000)}k characters; the limit is ${maxChars / 1000}k).`,
        upgrade: tier !== "pro" && tier !== "team",
      },
      { status: 413 }
    );
  }

  // Count only requests that will actually reach the model.
  const usageKey = user ? `u:${user.id}` : `ip:${clientIp(request)}`;
  const remaining = consume(usageKey, limit);
  if (remaining < 0) {
    return Response.json(
      { error: "You've used today's AI answers.", upgrade: tier !== "pro" && tier !== "team" },
      { status: 429 }
    );
  }
  if (messages[0].role !== "user" || messages[messages.length - 1].role !== "user") {
    return json(400, "Conversation must start and end with a user message.");
  }

  // Document first (cached), then the first question, then the rest verbatim.
  const apiMessages: Anthropic.Beta.BetaMessageParam[] = messages.map((m, i) =>
    i === 0
      ? {
          role: "user",
          content: [
            {
              type: "text",
              text: `<document name="${documentName.replace(/"/g, "'")}">\n${documentText}\n</document>`,
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: m.content },
          ],
        }
      : { role: m.role, content: m.content }
  );

  const client = new Anthropic();
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    async start(controller) {
      let delivered = false;
      const send = (event: Record<string, unknown>) => {
        if (event.type === "text") delivered = true;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const stream = client.beta.messages.stream({
          model: MODEL,
          max_tokens: 16000,
          // Document Q&A rarely needs the deepest reasoning; medium keeps
          // answers fast. Raise it if answer quality on hard documents suffers.
          output_config: { effort: "medium" },
          // If a safety classifier declines, re-run on Anthropic's
          // recommended fallback model instead of failing the user.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          messages: apiMessages,
        });

        request.signal.addEventListener("abort", () => stream.abort());

        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            send({ type: "text", text: event.delta.text });
          }
        }

        const final = await stream.finalMessage();
        if (final.stop_reason === "refusal") {
          send({ type: "error", message: "The assistant couldn't help with this request." });
        }
        send({ type: "done", stopReason: final.stop_reason });
      } catch (error) {
        let message = "The assistant ran into a problem. Please try again.";
        if (error instanceof Anthropic.RateLimitError) message = "The assistant is busy right now. Try again in a moment.";
        else if (error instanceof Anthropic.BadRequestError) message = "The assistant couldn't process this document.";
        else if (error instanceof Anthropic.APIUserAbortError) message = "Stopped.";
        else console.error("ai/chat error", error);
        // An answer that never arrived shouldn't cost the user a turn.
        if (!delivered) refund(usageKey);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "x-ai-remaining": String(remaining),
    },
  });
}
