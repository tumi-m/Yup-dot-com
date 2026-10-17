/**
 * What the pricing cards offer a signed-in customer, why a checkout is
 * refused, and how the payment return page reads the verify response. Works
 * from the billing summary, without Node APIs, so the checkout route, the
 * browser and the tests share one set of rules.
 */
import { PLANS, formatBillingDate, type PaidPlanId } from "./plans";
import type { BillingSummary } from "./billing";
import type { PlanId } from "./types";

const RANK: Record<PlanId, number> = { free: 0, pro: 1, team: 2 };

type Billing = BillingSummary | null | undefined;

/** The plan the customer pays for themselves right now (not a Team seat). */
function ownPlanOf(billing: Billing): PlanId {
  let plan: PlanId = "free";
  if (billing?.subscription?.active) plan = billing.subscription.plan;
  const pre = billing?.prepaid;
  if (pre?.active && RANK[pre.plan] > RANK[plan]) plan = pre.plan;
  return plan;
}

/**
 * Why a monthly subscription to `plan` can't start now, or null when it can.
 * A live subscription would be charged beside the new one, and a new plan
 * would cut short a cancelled one that is paid up, so both have to end first.
 */
export function subscribeBlock(plan: PaidPlanId, billing: Billing): string | null {
  const sub = billing?.subscription;
  if (!sub?.active) return null;
  const current = PLANS[sub.plan].name;
  const next = PLANS[plan].name;
  if (sub.renews) {
    return sub.plan === plan
      ? `You already subscribe to ${current}.`
      : `To switch to ${next}, cancel ${current} under Manage subscription on the Billing page. Subscribe to ${next} once it ends.`;
  }
  if (sub.status === "non-renewing" || sub.plan !== plan) {
    const ends = sub.periodEnd ? `ends ${formatBillingDate(sub.periodEnd)}` : "is still running";
    return `Your ${current} plan ${ends}. Subscribe ${sub.plan === plan ? "again" : `to ${next}`} after that.`;
  }
  return null;
}

/** Why a prepaid term on `plan` can't be bought now, or null when it can. */
export function payOnceBlock(plan: PaidPlanId, billing: Billing): string | null {
  const own = ownPlanOf(billing);
  return RANK[own] > RANK[plan] ? `Your ${PLANS[own].name} plan already includes ${PLANS[plan].name}.` : null;
}

export interface CardOffer {
  /** The main button: current plan, part of a higher plan, subscribe, or a note instead. */
  main: "current" | "included" | "subscribe" | "blocked";
  /** The button label for "included", the note for "blocked". */
  text: string | null;
  payOnce: boolean;
  /** Shown with the pay-once links. */
  payOnceNote: string | null;
}

/** What a paid plan's card offers someone on `current` (undefined when signed out). */
export function cardOffer(plan: PaidPlanId, current: PlanId | undefined, billing: Billing): CardOffer {
  const cur = current ?? "free";
  if (plan === cur) return { main: "current", text: null, payOnce: false, payOnceNote: null };
  if (RANK[plan] < RANK[cur]) {
    return { main: "included", text: `Included in ${PLANS[cur].name}`, payOnce: false, payOnceNote: null };
  }
  const block = subscribeBlock(plan, billing);
  const pre = billing?.prepaid;
  return {
    main: block ? "blocked" : "subscribe",
    text: block,
    payOnce: !payOnceBlock(plan, billing),
    payOnceNote: pre?.active && pre.plan !== plan ? `Your ${PLANS[pre.plan].name} time left carries over.` : null,
  };
}

export type PaymentOutcome = "success" | "failed" | "other-account" | "not-applied" | "retry" | "unknown";

/**
 * Reads a /api/billing/verify response. "failed" (nothing was charged) only
 * when Paystack says so; anything unexpected is "unknown", not "failed".
 */
export function paymentOutcome(httpStatus: number, status: unknown): PaymentOutcome {
  switch (status) {
    case "success":
    case "other-account":
    case "not-applied":
      return status;
    case "failed":
    case "abandoned":
    case "reversed":
      return "failed";
    case "ongoing":
    case "pending":
    case "processing":
    case "queued":
      return "retry";
  }
  return httpStatus === 202 ? "retry" : "unknown";
}
