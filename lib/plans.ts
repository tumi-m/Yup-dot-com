import type { PlanFeature, PlanId } from "./types";

/** Paystack in South Africa settles in rand only. */
export const CURRENCY = "ZAR";

/** Team plan: the owner plus this many invited members. */
export const TEAM_SEATS = 5;
export const TEAM_MEMBER_LIMIT = TEAM_SEATS - 1;

export const PLANS: Record<PlanId, PlanFeature> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    currency: CURRENCY,
    description: "Free forever.",
    maxDocuments: 5,
    features: [
      "Every tool",
      "1 edit a day",
      "50 MB files, 10 at a time",
      "Video up to 720p",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 49,
    currency: CURRENCY,
    description: "For heavy use.",
    maxDocuments: -1,
    highlighted: true,
    features: [
      "Unlimited edits, no watermark",
      "500 MB files, 200 at a time",
      "Video in 1080p",
      "40 AI answers a day, 600 a month",
      "Unlimited cloud storage",
    ],
  },
  team: {
    id: "team",
    name: "Team",
    priceMonthly: 199,
    currency: CURRENCY,
    description: "Pro for teams.",
    maxDocuments: -1,
    features: ["Everything in Pro", `${TEAM_SEATS} seats`],
  },
};

export const PLAN_LIST: PlanFeature[] = [PLANS.free, PLANS.pro, PLANS.team];

export type PaidPlanId = Exclude<PlanId, "free">;
export const PAID_PLANS: PaidPlanId[] = ["pro", "team"];

export function isPaidPlan(plan: unknown): plan is PaidPlanId {
  return plan === "pro" || plan === "team";
}

export function maxDocumentsFor(plan: PlanId): number {
  return PLANS[plan].maxDocuments;
}

/** Prepaid terms on offer. A year costs ten months (two months free). */
export const PREPAID_MONTHS = [1, 12] as const;
export type PrepaidMonths = (typeof PREPAID_MONTHS)[number];

export function isPrepaidMonths(n: unknown): n is PrepaidMonths {
  return n === 1 || n === 12;
}

/** Whole rand charged for a prepaid term. */
export function prepaidPrice(plan: PaidPlanId, months: PrepaidMonths): number {
  return PLANS[plan].priceMonthly * (months === 12 ? 10 : 1);
}

/** Every rand amount the UI shows: monthly prices and prepaid terms. */
export const PRICE_AMOUNTS: number[] = Array.from(
  new Set(
    PLAN_LIST.flatMap((p) =>
      isPaidPlan(p.id)
        ? [p.priceMonthly, ...PREPAID_MONTHS.map((m) => prepaidPrice(p.id as PaidPlanId, m))]
        : [p.priceMonthly]
    )
  )
);

/** Rand → cents (Paystack's subunit for ZAR). */
export function toSubunit(rand: number): number {
  return Math.round(rand * 100);
}

/**
 * "R49", "R1 990", "R49,50": South African style, with a non-breaking space
 * between thousands. Built by hand rather than with Intl because Node and
 * browsers ship different en-ZA data ("R 1 990" vs "R1,990"), which would
 * make server and client render different text.
 */
export function formatPrice(rand: number): string {
  const sign = rand < 0 ? "-" : "";
  const cents = Math.round(Math.abs(rand) * 100);
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  const frac = cents % 100;
  return `${sign}R${whole}${frac ? "," + String(frac).padStart(2, "0") : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SAST_MS = 2 * 60 * 60 * 1000; // South Africa is UTC+2 all year.

/** "4 Nov 2026", in South African time. Deterministic on server and client. */
export function formatBillingDate(iso: string | Date): string {
  const d = new Date((typeof iso === "string" ? new Date(iso) : iso).getTime() + SAST_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
