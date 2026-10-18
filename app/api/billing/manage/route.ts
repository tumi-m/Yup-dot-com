import { billingContext, json } from "@/lib/billing-route";
import { refuseCrossSite } from "@/lib/cross-site";
import { subscriptionManageLink } from "@/lib/paystack";

export const dynamic = "force-dynamic";

/** Paystack's hosted page for updating the card or cancelling. */
export async function POST(request: Request) {
  const refused = refuseCrossSite(request, { json: false });
  if (refused) return refused;
  const ctx = await billingContext();
  if (ctx instanceof Response) return ctx;
  const { row, profile } = ctx.account;

  // While it gives access or Paystack may still charge it (past due).
  const code = row.paystack_subscription_code;
  if (!code || !profile.billing.subscription?.manageable) {
    return json({ error: "No subscription to manage." }, 400);
  }
  try {
    const { link } = await subscriptionManageLink(ctx.paystack, code);
    return json({ url: link });
  } catch (err) {
    console.error("paystack manage link failed", err);
    return json({ error: "Couldn't open subscription settings. Try again." }, 502);
  }
}
