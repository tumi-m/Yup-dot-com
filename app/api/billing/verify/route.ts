import { applyCharge, parseMetadata } from "@/lib/billing";
import { supabaseBillingStore } from "@/lib/billing-store";
import { billingContext, json } from "@/lib/billing-route";
import { isOurReference, planForCode, verifyTransaction } from "@/lib/paystack";

export const dynamic = "force-dynamic";

/**
 * Called when the customer returns from checkout. Confirms the payment with
 * Paystack server-side and applies it right away, rather than waiting for
 * the webhook. Applying is idempotent: the webhook and this route share the
 * reference as their key.
 */
export async function GET(request: Request) {
  const ctx = await billingContext();
  if (ctx instanceof Response) return ctx;
  const { account, paystack } = ctx;

  const reference = new URL(request.url).searchParams.get("reference");
  if (!isOurReference(reference)) return json({ error: "Unknown payment." }, 400);

  let tx: Record<string, unknown>;
  try {
    tx = await verifyTransaction(paystack, reference);
  } catch {
    return json({ status: "pending" }, 202);
  }
  if (parseMetadata(tx.metadata).user_id !== account.user.id) {
    return json({ error: "Unknown payment." }, 404);
  }
  if (tx.status !== "success") {
    // abandoned, failed, ongoing, pending…
    return json({ status: typeof tx.status === "string" ? tx.status : "pending" });
  }

  try {
    const result = await applyCharge(tx, { store: supabaseBillingStore(), planForCode: (c) => planForCode(c) });
    if (result.status === "ignored") {
      console.error("payment not applied", reference, result.reason);
      return json({ status: "failed" }, 422);
    }
    return json({ status: "success" });
  } catch (err) {
    console.error("apply payment failed", err);
    return json({ status: "pending" }, 202);
  }
}
