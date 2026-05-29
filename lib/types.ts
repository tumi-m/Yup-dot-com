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

/** ---- Editor annotation model (client-side) ---- */

export type AnnotationType = "text" | "highlight" | "draw" | "signature";

export interface BaseAnnotation {
  id: string;
  type: AnnotationType;
  page: number; // 0-indexed
  // Position/size are stored in PDF user-space units (points), origin top-left,
  // so they survive zoom changes and translate cleanly to pdf-lib.
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextAnnotation extends BaseAnnotation {
  type: "text";
  text: string;
  fontSize: number;
  color: string; // hex
}

export interface HighlightAnnotation extends BaseAnnotation {
  type: "highlight";
  color: string; // hex
  opacity: number;
}

export interface DrawAnnotation extends BaseAnnotation {
  type: "draw";
  // points are relative to the annotation box (0..width / 0..height, in points)
  points: { x: number; y: number }[];
  color: string;
  strokeWidth: number;
}

export interface SignatureAnnotation extends BaseAnnotation {
  type: "signature";
  dataUrl: string; // PNG data url
}

export type Annotation =
  | TextAnnotation
  | HighlightAnnotation
  | DrawAnnotation
  | SignatureAnnotation;

export interface PlanFeature {
  id: PlanId;
  name: string;
  priceMonthly: number;
  description: string;
  features: string[];
  maxDocuments: number; // -1 = unlimited
  highlighted?: boolean;
}
