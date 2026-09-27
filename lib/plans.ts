import type { PlanFeature, PlanId } from "./types";

export const PLANS: Record<PlanId, PlanFeature> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    description: "Every tool, free forever. No sign-up, no card.",
    maxDocuments: 5,
    features: [
      "Every tool — no account needed",
      "Full editor, forms & e-sign, no watermark",
      "Files up to 50 MB, 10 at a time",
      "3 AI answers a day (15 with a free account)",
      "5 cloud documents with a free account",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceMonthly: 12,
    description: "For professionals who live in their documents.",
    maxDocuments: -1,
    highlighted: true,
    features: [
      "Everything in Free",
      "Files up to 500 MB, 200 at a time",
      "300 AI answers a day",
      "Unlimited cloud documents",
      "Saved signatures (coming soon)",
    ],
  },
  team: {
    id: "team",
    name: "Team",
    priceMonthly: 39,
    description: "Pro for your whole team. Shared workspaces are on the way.",
    maxDocuments: -1,
    features: [
      "Everything in Pro",
      "Up to 10 seats (coming soon)",
      "Shared library (coming soon)",
      "Audit log (coming soon)",
      "SSO (coming soon)",
    ],
  },
};

export const PLAN_LIST: PlanFeature[] = [PLANS.free, PLANS.pro, PLANS.team];

export function maxDocumentsFor(plan: PlanId): number {
  return PLANS[plan].maxDocuments;
}
