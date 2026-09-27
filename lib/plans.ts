import type { PlanFeature, PlanId } from "./types";

export const PLANS: Record<PlanId, PlanFeature> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    description: "Every tool, free forever. No card needed.",
    maxDocuments: 5,
    features: [
      "Every browser tool, unlimited",
      "OCR, Word & Excel conversion",
      "Full editor, forms & e-sign",
      "Up to 5 cloud documents",
      "Editor exports carry a small watermark",
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
      "Unlimited cloud documents",
      "No watermark on editor exports",
      "Saved signatures (coming soon)",
      "Version history (coming soon)",
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
