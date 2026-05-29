import Stripe from "stripe";
import type { PlanId } from "./types";

let _stripe: Stripe | null = null;

/** Lazily-initialised server-side Stripe client. */
export function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    _stripe = new Stripe(key, { apiVersion: "2025-02-24.acacia" });
  }
  return _stripe;
}

/** Maps our internal plan ids to the Stripe price ids from the environment. */
export function priceIdForPlan(plan: PlanId): string | null {
  switch (plan) {
    case "pro":
      return process.env.STRIPE_PRICE_PRO ?? null;
    case "team":
      return process.env.STRIPE_PRICE_TEAM ?? null;
    default:
      return null;
  }
}

/** Reverse lookup: which plan does a Stripe price id correspond to? */
export function planForPriceId(priceId: string | null | undefined): PlanId {
  if (!priceId) return "free";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === process.env.STRIPE_PRICE_TEAM) return "team";
  return "free";
}
