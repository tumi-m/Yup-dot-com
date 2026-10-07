import { z } from "zod";
import { siteUrl } from "@/lib/site";
import { hasLiveSubscription } from "@/lib/billing";
import { billingContext, json } from "@/lib/billing-route";
import { PLANS, prepaidPrice, toSubunit } from "@/lib/plans";
import {
  ONCE_OFF_CHANNELS,
  PaystackError,
  SUBSCRIPTION_CHANNELS,
  initializeTransaction,
  newReference,
  planCodes,
} from "@/lib/paystack";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("subscription"), plan: z.enum(["pro", "team"]) }),
  z.object({
    mode: z.literal("once"),
    plan: z.enum(["pro", "team"]),
    months: z.union([z.literal(1), z.literal(12)]),
  }),
]);

/**
 * Starts a Paystack checkout. `{ plan }` subscribes monthly (card only);
 * `{ plan, mode: "once", months: 1 | 12 }` pays up front with any South
 * African channel. Returns the hosted checkout URL.
 */
export async function POST(request: Request) {
  const ctx = await billingContext();
  if (ctx instanceof Response) return ctx;
  const { account, paystack } = ctx;

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = bodySchema.safeParse(raw && !raw.mode ? { ...raw, mode: "subscription" } : raw);
  if (!parsed.success) return json({ error: "Invalid plan." }, 400);
  const input = parsed.data;

  const email = account.user.email;
  if (!email) return json({ error: "Your account needs an email address." }, 400);

  const reference = newReference();
  const callbackUrl = `${siteUrl()}/settings/billing?ref=${reference}`;

  let amount: number;
  let plan: string | undefined;
  let channels: readonly string[];
  const metadata: Record<string, unknown> = { user_id: account.user.id, plan: input.plan, mode: input.mode };

  if (input.mode === "subscription") {
    plan = planCodes()[input.plan] ?? undefined;
    if (!plan) return json({ error: "This plan isn't set up yet." }, 503);
    if (hasLiveSubscription(account.row, new Date())) {
      return json({ error: "You already have a subscription. Manage it on the Billing page." }, 409);
    }
    amount = toSubunit(PLANS[input.plan].priceMonthly);
    channels = SUBSCRIPTION_CHANNELS;
  } else {
    amount = toSubunit(prepaidPrice(input.plan, input.months));
    metadata.months = input.months;
    channels = ONCE_OFF_CHANNELS;
  }

  try {
    const tx = await initializeTransaction(paystack, {
      email,
      amount,
      reference,
      callbackUrl,
      metadata,
      channels,
      plan,
    });
    return json({ url: tx.authorization_url, reference });
  } catch (err) {
    const status = err instanceof PaystackError ? err.status : 502;
    console.error("paystack initialize failed", err);
    return json({ error: "Couldn't start checkout. Try again." }, status >= 500 ? 502 : 400);
  }
}
