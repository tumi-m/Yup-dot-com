import { z } from "zod";
import { verifyToken, workerConfig } from "@/lib/media-server";
import { askWorker, grantRef, REFUND_GRACE_SECONDS, REFUNDABLE, refundGrant } from "@/lib/media-refund";
import { usageStore } from "@/lib/usage";

export const runtime = "nodejs";
export const maxDuration = 20;

const bodySchema = z.object({ token: z.string().min(10).max(4000) });

/**
 * YouTube: gives a download back when its worker job failed, was cancelled,
 * or never started. The browser sends the grant it was given; the worker's
 * own record of that grant decides, so a finished download can't be refunded.
 */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  const config = workerConfig();
  if (!parsed.success || !config.ok) return Response.json({ refunded: false }, { status: 400 });
  const ref = grantRef(verifyToken(parsed.data.token, config.secret, REFUND_GRACE_SECONDS));
  if (!ref) return Response.json({ refunded: false }, { status: 400 });

  const verdict = await askWorker(config.url, config.secret, ref.c);
  if (!REFUNDABLE.includes(verdict)) return Response.json({ refunded: false }, { status: 409 });
  return Response.json({ refunded: await refundGrant(usageStore(), ref) });
}
