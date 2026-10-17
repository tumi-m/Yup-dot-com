import { z } from "zod";
import { verifyToken, workerConfig } from "@/lib/media-server";
import { askWorker, grantRef, REFUND_GRACE_SECONDS, REFUNDABLE, refundGrant } from "@/lib/media-refund";
import { usageStore } from "@/lib/usage";
import { refuseCrossSite } from "@/lib/cross-site";

export const runtime = "nodejs";
export const maxDuration = 20;

const bodySchema = z.object({ token: z.string().min(10).max(4000) });

/**
 * YouTube: gives a download back when its worker job failed, was cancelled,
 * or never started. The browser sends the grant it was given; the worker voids
 * it and its own record of it decides, so a finished download can't be
 * refunded and a refunded grant can't start one (lib/media-refund.ts).
 */
export async function POST(request: Request) {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const config = workerConfig();
  if (!parsed.success || !config.ok) return Response.json({ refunded: false }, { status: 400 });
  const ref = grantRef(verifyToken(parsed.data.token, config.secret, REFUND_GRACE_SECONDS));
  if (!ref) return Response.json({ refunded: false }, { status: 400 });

  const verdict = await askWorker(config.url, config.secret, ref);
  if (!REFUNDABLE.includes(verdict)) return Response.json({ refunded: false }, { status: 409 });
  return Response.json({ refunded: await refundGrant(usageStore(), ref) });
}
