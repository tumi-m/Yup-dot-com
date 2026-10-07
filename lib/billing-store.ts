/**
 * Supabase-backed billing data, using the service-role client. Server-only:
 * billing columns, webhook events and team lists are not writable from the
 * browser (see supabase/schema.sql).
 */
import { createAdminClient } from "@/lib/supabase/server";
import { BILLING_COLUMNS, type BillingPatch, type BillingRow, type BillingStore } from "@/lib/billing";

// The admin client is created via require() and is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const COLUMNS = BILLING_COLUMNS.join(",");

export function isAdminConfigured(): boolean {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.NEXT_PUBLIC_SUPABASE_URL;
}

function fail(what: string, error: { message?: string } | null) {
  if (error) throw new Error(`${what}: ${error.message ?? "database error"}`);
}

export function supabaseBillingStore(admin: Admin = createAdminClient()): BillingStore {
  return {
    async claimEvent(key, type) {
      const { error } = await admin.from("billing_events").insert({ id: key, type });
      if (!error) return true;
      if (error.code === "23505") return false; // unique violation: already processed
      fail("claim event", error);
      return false;
    },
    async releaseEvent(key) {
      await admin.from("billing_events").delete().eq("id", key);
    },
    async getRow(userId) {
      const { data, error } = await admin.from("profiles").select(COLUMNS).eq("id", userId).maybeSingle();
      fail("read profile", error);
      return (data as BillingRow) ?? null;
    },
    async findUserId(by) {
      const [column, value] = by.subscriptionCode
        ? ["paystack_subscription_code", by.subscriptionCode]
        : by.customerCode
          ? ["paystack_customer_code", by.customerCode]
          : ["email", by.email?.toLowerCase()];
      if (!value) return null;
      const { data, error } = await admin.from("profiles").select("id").eq(column, value).limit(1);
      fail("find customer", error);
      return (data?.[0]?.id as string) ?? null;
    },
    async updateRow(userId, patch: BillingPatch) {
      const { error } = await admin.from("profiles").update(patch).eq("id", userId);
      fail("update billing", error);
    },
  };
}

// ---------- Team seats ----------

export interface TeamMember {
  email: string;
  created_at: string;
}

export async function listTeamMembers(ownerId: string, admin: Admin = createAdminClient()): Promise<TeamMember[]> {
  const { data, error } = await admin
    .from("team_members")
    .select("email, created_at")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  fail("list team", error);
  return (data as TeamMember[]) ?? [];
}

export async function addTeamMember(ownerId: string, email: string, admin: Admin = createAdminClient()) {
  const { error } = await admin.from("team_members").insert({ owner_id: ownerId, email });
  if (error?.code === "23505") return; // already there
  fail("add member", error);
}

export async function removeTeamMember(ownerId: string, email: string, admin: Admin = createAdminClient()) {
  const { error } = await admin.from("team_members").delete().eq("owner_id", ownerId).eq("email", email);
  fail("remove member", error);
}

/** Billing rows of every owner whose Team lists this email. */
export async function teamOwnersFor(email: string, admin: Admin = createAdminClient()): Promise<BillingRow[]> {
  const { data: links, error } = await admin
    .from("team_members")
    .select("owner_id")
    .eq("email", email.toLowerCase());
  fail("find teams", error);
  const ids = ((links as { owner_id: string }[]) ?? []).map((l) => l.owner_id);
  if (ids.length === 0) return [];
  const { data, error: e2 } = await admin.from("profiles").select(COLUMNS).in("id", ids);
  fail("read team owners", e2);
  return (data as BillingRow[]) ?? [];
}
