export type PlanId = "free" | "pro" | "team";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  plan: PlanId;
  stripe_customer_id: string | null;
  created_at: string;
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

export interface Subscription {
  id: string;
  user_id: string;
  status: string;
  plan: PlanId;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}

export interface PlanFeature {
  id: PlanId;
  name: string;
  priceMonthly: number;
  description: string;
  features: string[];
  maxDocuments: number; // -1 = unlimited
  highlighted?: boolean;
}
