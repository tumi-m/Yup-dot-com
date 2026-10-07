import { billingContext, json } from "@/lib/billing-route";
import { subscriptionActive } from "@/lib/billing";
import { subscriptionManageLink } from "@/lib/paystack";

export const dynamic = "force-dynamic";

/** Paystack's hosted page for updating the card or cancelling. */
export async function POST() {
  const ctx = await billingContext();
  if (ctx instanceof Response) return ctx;
  const { row } = ctx.account;

  const code = row.paystack_subscription_code;
  if (!code || !subscriptionActive(row, new Date())) {
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
