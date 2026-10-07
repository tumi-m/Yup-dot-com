import { z } from "zod";
import { resolveTier } from "@/lib/tier";
import { claimEdit, usageSubject } from "@/lib/usage";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** SHA-256 (hex) of the document as it will be saved: same document, same fingerprint. */
  doc: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Called by Edit PDF, Sign PDF and Edit PPTX right before they build a file
 * to save or download. Spends one of today's edits (Free: 1, Pro/Team:
 * unlimited); the same unchanged document again today is free. The answer
 * also says whether the file gets the "Made with PDF Wizard" mark.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { user, tier } = await resolveTier();
  const claim = await claimEdit(usageSubject(request, user), tier, parsed.data.doc);
  return Response.json(
    claim.allowed ? claim : { ...claim, error: "You've used today's free edit.", upgrade: true, reason: "edits" },
    { status: claim.allowed ? 200 : 429, headers: { "Cache-Control": "no-store" } }
  );
}
