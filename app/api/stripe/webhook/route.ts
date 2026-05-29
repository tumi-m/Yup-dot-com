import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe, planForPriceId } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/server";
import type { PlanId } from "@/lib/types";

// Stripe needs the raw body to verify the signature.
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = request.headers.get("stripe-signature");

  if (!secret || !signature) {
    return NextResponse.json({ error: "Webhook not configured." }, { status: 400 });
  }

  const payload = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid signature: ${err instanceof Error ? err.message : ""}` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  async function setPlanForCustomer(
    customerId: string,
    plan: PlanId,
    sub?: Stripe.Subscription
  ) {
    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (!profile) return;

    await admin.from("profiles").update({ plan }).eq("id", profile.id);

    if (sub) {
      await admin.from("subscriptions").upsert(
        {
          user_id: profile.id,
          stripe_subscription_id: sub.id,
          status: sub.status,
          plan,
          current_period_end: new Date(
            sub.current_period_end * 1000
          ).toISOString(),
        },
        { onConflict: "stripe_subscription_id" }
      );
    }
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items.data[0]?.price.id;
      const active = sub.status === "active" || sub.status === "trialing";
      const plan = active ? planForPriceId(priceId) : "free";
      await setPlanForCustomer(sub.customer as string, plan, sub);
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await setPlanForCustomer(sub.customer as string, "free", sub);
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
