import type { PlanFeature, PlanId } from "./types";

export const PLANS: Record<PlanId, PlanFeature> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    description: "Free forever.",
    maxDocuments: 5,
    features: [
      "Every tool, no account",
      "No watermark",
      "50 MB files, 10 at a time",
      "Video up to 720p",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 12,
    description: "For heavy use.",
    maxDocuments: -1,
    highlighted: true,
    features: [
      "500 MB files, 200 at a time",
      "Video in 1080p",
      "300 AI answers a day",
      "Unlimited cloud storage",
    ],
  },
  team: {
    id: "team",
    name: "Team",
    priceMonthly: 39,
    description: "Pro for teams.",
    maxDocuments: -1,
    features: [
      "Everything in Pro",
      "Team seats (coming soon)",
    ],
  },
};

export const PLAN_LIST: PlanFeature[] = [PLANS.free, PLANS.pro, PLANS.team];

export function maxDocumentsFor(plan: PlanId): number {
  return PLANS[plan].maxDocuments;
}
