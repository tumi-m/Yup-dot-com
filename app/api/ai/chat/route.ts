import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getCurrentUser } from "@/lib/supabase/server";

/**
 * Chat with / summarize a PDF.
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
// ~150k tokens. Larger documents are rejected with a clear message rather
// than silently truncated, which would produce confidently incomplete answers.
const MAX_DOCUMENT_CHARS = 600_000;
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

/** Best-effort per-user limit. Per-instance on serverless — a backstop, not billing control. */
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT_PER_WINDOW = 40;
const hits = new Map<string, number[]>();
function allow(userId: string) {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT_PER_WINDOW) return false;
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

function json(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(503, "The AI assistant isn't configured on this deployment yet.");
  }

  const user = await getCurrentUser();
  if (!user) return json(401, "Sign in to use the AI assistant.");
  if (!allow(user.id)) return json(429, "You've hit the hourly limit. Try again a little later.");

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, "Invalid request.");
  const { documentName, documentText, messages } = parsed.data;

  if (documentText.length > MAX_DOCUMENT_CHARS) {
    return json(
      413,
      `This document is too long for the assistant (${Math.round(documentText.length / 1000)}k characters; the limit is ${MAX_DOCUMENT_CHARS / 1000}k). Split it into smaller parts first.`
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
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
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
    },
  });
}
