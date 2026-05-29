import type { PlanFeature, PlanId } from "./types";

export const PLANS: Record<PlanId, PlanFeature> = {
  free: {
    id: "free",
    name: "Free",
    priceMonthly: 0,
    description: "Everything you need to edit the occasional PDF.",
    maxDocuments: 5,
    features: [
      "Up to 5 documents",
      "Annotate, highlight & draw",
      "Merge, split & reorder pages",
      "Fill & sign",
      "Export with watermark",
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
      "Unlimited documents",
      "No export watermark",
      "Priority processing",
      "Saved signatures",
      "Version history",
    ],
  },
  team: {
    id: "team",
    name: "Team",
    priceMonthly: 39,
    description: "Shared workspaces for the whole team.",
    maxDocuments: -1,
    features: [
      "Everything in Pro",
      "Up to 10 seats",
      "Shared document library",
      "Audit log",
      "SSO (coming soon)",
    ],
  },
};

export const PLAN_LIST: PlanFeature[] = [PLANS.free, PLANS.pro, PLANS.team];

export function maxDocumentsFor(plan: PlanId): number {
  return PLANS[plan].maxDocuments;
}
