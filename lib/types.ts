import type { BillingSummary } from "./billing";

export type PlanId = "free" | "pro" | "team";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  /** The effective plan, resolved at read time (see lib/billing.ts). */
  plan: PlanId;
  created_at: string;
  billing: BillingSummary;
}

export interface DocumentRecord {
  id: string;
  owner_id: string;
  name: string;
  storage_path: string;
  size_bytes: number;
  page_count: number;
  updated_at: string;
  created_at: string;
}

export interface PlanFeature {
  id: PlanId;
  name: string;
  /** Whole units of `currency` per month. */
  priceMonthly: number;
  currency: string;
  description: string;
  features: string[];
  maxDocuments: number; // -1 = unlimited
  highlighted?: boolean;
}
