/**
 * What the pricing cards offer a signed-in customer, why a checkout is
 * refused, what the Billing page says about the plan, and how the payment
 * return page reads the verify response. Works from the billing summary,
 * without Node APIs, so the checkout route, the browser and the tests share
 * one set of rules.
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
 * A live subscription would be charged beside the new one (a past-due one
 * too, after its access ended), a new plan would cut short a cancelled one
 * that is paid up, and a prepaid term would run out unused beside it, so
 * each has to end first. (Paying once instead carries a prepaid term's time
 * over.)
 */
export function subscribeBlock(plan: PaidPlanId, billing: Billing): string | null {
  const sub = billing?.subscription;
  const next = PLANS[plan].name;
  if (sub?.active || sub?.live) {
    const current = PLANS[sub.plan].name;
    if (sub.renews) {
      if (sub.plan !== plan) {
        return `To switch to ${next}, cancel ${current} under Manage subscription on the Billing page. Subscribe to ${next} once it ends.`;
      }
      return sub.pastDue
        ? `Your ${current} payment failed. Update your card on the Billing page.`
        : `You already subscribe to ${current}.`;
    }
    if (sub.status === "non-renewing" || sub.plan !== plan) {
      const ends = sub.periodEnd ? `ends ${formatBillingDate(sub.periodEnd)}` : "is still running";
      return `Your ${current} plan ${ends}. Subscribe ${sub.plan === plan ? "again" : `to ${next}`} after that.`;
    }
  }
  const pre = billing?.prepaid;
  if (pre?.active) {
    return `Your ${PLANS[pre.plan].name} plan is paid until ${formatBillingDate(pre.paidUntil)}. Subscribe to ${next} after that.`;
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
  const notes = [
    pre?.active && pre.plan !== plan ? `Your ${PLANS[pre.plan].name} time left carries over.` : null,
    renewalNote(plan, billing),
  ].filter(Boolean);
  return {
    main: block ? "blocked" : "subscribe",
    text: block,
    payOnce: !payOnceBlock(plan, billing),
    payOnceNote: notes.length ? notes.join(" ") : null,
  };
}

/** Paying once for `plan` doesn't stop a subscription to another plan: say it's still charged. */
function renewalNote(plan: PaidPlanId, billing: Billing): string | null {
  const sub = billing?.subscription;
  if (!sub?.live || !sub.renews || sub.plan === plan) return null;
  const name = PLANS[sub.plan].name;
  const when = sub.periodEnd && !sub.pastDue ? ` on ${formatBillingDate(sub.periodEnd)}` : "";
  return `Your ${name} subscription still renews${when}. Cancel it under Manage subscription.`;
}

/**
 * The lines under the plan name on the Billing page. A renewing
 * subscription is listed even when another plan is in use, so the next
 * charge is never hidden, and so is a prepaid term running beside a
 * subscription or a Team seat, so paid time is never hidden either.
 */
export function planStatus(billing: BillingSummary): string[] {
  const { subscription: sub, prepaid } = billing;
  if (billing.source === "subscription" && sub) {
    const label = sub.pastDue ? "Payment due" : sub.renews ? "Renews" : "Ends";
    const lines = sub.periodEnd ? [`${label} ${formatBillingDate(sub.periodEnd)}`] : [];
    if (prepaid?.active) lines.push(`${PLANS[prepaid.plan].name} paid until ${formatBillingDate(prepaid.paidUntil)}`);
    return lines;
  }
  const lines: string[] = [];
  if (billing.source === "prepaid" && prepaid) {
    lines.push(`Paid until ${formatBillingDate(prepaid.paidUntil)}`);
  } else if (billing.source === "team") {
    lines.push(billing.teamOwnerEmail ? `Seat on ${billing.teamOwnerEmail}'s team` : "Team seat");
    if (prepaid?.active) lines.push(`${PLANS[prepaid.plan].name} paid until ${formatBillingDate(prepaid.paidUntil)}`);
  } else if (prepaid && !prepaid.active) {
    lines.push(`${PLANS[prepaid.plan].name} ended ${formatBillingDate(prepaid.paidUntil)}`);
  }
  if (sub?.active && sub.renews && sub.periodEnd) {
    lines.push(`${PLANS[sub.plan].name} subscription ${sub.pastDue ? "payment due" : "renews"} ${formatBillingDate(sub.periodEnd)}`);
  }
  return lines;
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

/** The name of the plan a successful verify response says is in use, or null. */
export function paymentPlanName(plan: unknown): string | null {
  return plan === "free" || plan === "pro" || plan === "team" ? PLANS[plan].name : null;
}

/** Fast tries before the return page says the payment is still processing. */
const PENDING_AFTER = 8;

/** The wait before asking again, after `tries` answers of "still processing". */
export function verifyDelay(tries: number): number {
  return tries < PENDING_AFTER ? 2000 : Math.min(60_000, 15_000 * 2 ** (tries - PENDING_AFTER));
}

/**
 * Asks `verify` until the payment has an outcome: every 2 s at first, then
 * less often, up to once a minute, for as long as the page is open. A slow
 * EFT can take minutes. Null when stopped first.
 */
export async function waitForPayment(
  verify: () => Promise<PaymentOutcome>,
  { sleep, stopped, onPending }: { sleep: (ms: number) => Promise<void>; stopped: () => boolean; onPending: () => void }
): Promise<Exclude<PaymentOutcome, "retry"> | null> {
  for (let tries = 1; !stopped(); tries++) {
    const outcome = await verify();
    if (stopped()) break;
    if (outcome !== "retry") return outcome;
    if (tries === PENDING_AFTER) onPending();
    await sleep(verifyDelay(tries));
  }
  return null;
}
