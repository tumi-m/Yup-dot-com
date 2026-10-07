import { handlePaystackEvent, verifyPaystackSignature } from "@/lib/billing";
import { isAdminConfigured, supabaseBillingStore } from "@/lib/billing-store";
import { json } from "@/lib/billing-route";
import { planForCode } from "@/lib/paystack";

export const dynamic = "force-dynamic";

/**
 * Paystack webhook. Set https://<domain>/api/billing/webhook as the Webhook
 * URL in the Paystack dashboard. Requests are authenticated by an
 * HMAC-SHA512 of the raw body with the secret key. A non-2xx response makes
 * Paystack retry, so failures to record return 500; anything we deliberately
 * ignore returns 200.
 */
export async function POST(request: Request) {
  const secret = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secret || !isAdminConfigured()) return json({ error: "Webhook not configured." }, 503);

  const raw = Buffer.from(await request.arrayBuffer());
  if (!verifyPaystackSignature(raw, request.headers.get("x-paystack-signature"), secret)) {
    return json({ error: "Invalid signature." }, 401);
  }

  let event: { event?: unknown; data?: unknown };
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return json({ error: "Invalid JSON." }, 400);
  }

  try {
    const result = await handlePaystackEvent(event, raw, {
      store: supabaseBillingStore(),
      planForCode: (c) => planForCode(c),
    });
    if (result.status === "ignored") console.info("paystack event ignored", event.event, result.reason);
    return json({ received: true, status: result.status });
  } catch (err) {
    console.error("paystack event failed", event.event, err);
    return json({ error: "Not processed." }, 500);
  }
}
