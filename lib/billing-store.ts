/**
 * Supabase-backed billing data, using the service-role client. Server-only:
 * billing columns, webhook events and team lists are not writable from the
 * browser (see supabase/schema.sql).
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { BILLING_COLUMNS, type BillingPatch, type BillingRow, type BillingStore } from "@/lib/billing";
import type { PaidPlanId } from "@/lib/plans";
import { parseTesterAccess } from "@/lib/tester-access";

// The admin client is created via require() and is untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

const COLUMNS = BILLING_COLUMNS.join(",");

export function isAdminConfigured(): boolean {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.NEXT_PUBLIC_SUPABASE_URL;
}

/** A database error, with Postgres' error code when it gave one. */
export class StoreError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

function fail(what: string, error: { message?: string; code?: string } | null) {
  if (error) throw new StoreError(`${what}: ${error.message ?? "database error"}`, error.code);
}

// Postgres' and PostgREST's codes for a table that isn't there.
const MISSING_TABLE = new Set<string | undefined>(["42P01", "PGRST205"]);

const told = new Set<string>();
/** Says once per table that a migration hasn't been run. */
function missingTable(table: string) {
  if (told.has(table)) return;
  told.add(table);
  console.error(`Billing: no ${table} table. Run supabase/migrations/20261127000000_second_subscriptions.sql.`);
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
      const [{ data, error }, start] = await Promise.all([
        admin.from("profiles").select(COLUMNS).eq("id", userId).maybeSingle(),
        admin.from("subscription_starts").select("authorization_hash").eq("user_id", userId).maybeSingle(),
      ]);
      fail("read profile", error);
      // Without the table (migration not run yet) no first charge is waiting:
      // renewals and cancels go on, and a new subscription's first charge
      // fails (so Paystack sends it again) until it is run.
      if (!MISSING_TABLE.has(start.error?.code)) fail("read subscription start", start.error);
      if (!data) return null;
      return { ...(data as BillingRow), start_authorization: start.data?.authorization_hash ?? null };
    },
    async findUserId(by) {
      const [column, value] = by.subscriptionCode
        ? ["paystack_subscription_code", by.subscriptionCode]
        : ["paystack_customer_code", by.customerCode];
      if (!value) return null;
      const { data, error } = await admin.from("profiles").select("id").eq(column, value).limit(1);
      fail("find customer", error);
      return (data?.[0]?.id as string) ?? null;
    },
    async recordDuplicateStart(start) {
      const { error } = await admin.from("duplicate_subscription_starts").upsert({
        reference: start.reference,
        user_id: start.userId,
        plan: start.plan,
        authorization_hash: start.card,
        amount: start.amount,
      });
      // Without the table (migration not run yet) the charge is still not
      // applied, and the log line names it for a refund.
      if (MISSING_TABLE.has(error?.code)) return missingTable("duplicate_subscription_starts");
      fail("record second subscription", error);
    },
    async findDuplicateStart(userId: string, plan: PaidPlanId, card: string) {
      const { data, error } = await admin
        .from("duplicate_subscription_starts")
        .select("reference")
        .eq("user_id", userId)
        .eq("plan", plan)
        .eq("authorization_hash", card)
        .is("subscription_code", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (MISSING_TABLE.has(error?.code)) return null;
      fail("find second subscription", error);
      return (data?.[0]?.reference as string) ?? null;
    },
    async isDuplicateStart(reference: string) {
      const { data, error } = await admin.from("duplicate_subscription_starts").select("reference").eq("reference", reference).limit(1);
      if (MISSING_TABLE.has(error?.code)) return false;
      fail("read second subscription", error);
      return !!data?.length;
    },
    async resolveDuplicateStart(reference: string, subscriptionCode: string) {
      const { error } = await admin
        .from("duplicate_subscription_starts")
        .update({ subscription_code: subscriptionCode, stopped_at: new Date().toISOString() })
        .eq("reference", reference);
      if (MISSING_TABLE.has(error?.code)) return;
      fail("note stopped subscription", error);
    },
    async updateRow(userId, patch: BillingPatch) {
      const { start_authorization: card, ...profile } = patch;
      // The card first: a row the profile shows waiting always has it.
      if (card !== undefined) {
        const starts = admin.from("subscription_starts");
        const { error } = card
          ? await starts.upsert({ user_id: userId, authorization_hash: card, updated_at: new Date().toISOString() })
          : await starts.delete().eq("user_id", userId);
        fail("record subscription start", error);
      }
      const { error } = await admin.from("profiles").update(profile).eq("id", userId);
      fail("update billing", error);
    },
  };
}

// ---------- Checkout links ----------

export interface PendingCheckout {
  /** What was asked for, e.g. "pro:subscription". */
  request: string;
  reference: string;
  url: string;
  created_at: string;
}

/** The account's last checkout link, if one was made (see app/api/billing/checkout). */
export async function getPendingCheckout(userId: string, admin: Admin = createAdminClient()): Promise<PendingCheckout | null> {
  const { data, error } = await admin.from("pending_checkouts").select("request, reference, url, created_at").eq("user_id", userId).maybeSingle();
  if (MISSING_TABLE.has(error?.code)) {
    missingTable("pending_checkouts");
    return null;
  }
  fail("read checkout link", error);
  return (data as PendingCheckout) ?? null;
}

export async function savePendingCheckout(userId: string, c: Omit<PendingCheckout, "created_at">, admin: Admin = createAdminClient()) {
  const { error } = await admin
    .from("pending_checkouts")
    .upsert({ user_id: userId, request: c.request, reference: c.reference, url: c.url, created_at: new Date().toISOString() });
  if (MISSING_TABLE.has(error?.code)) return missingTable("pending_checkouts");
  fail("keep checkout link", error);
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

/** The database refused a member because every seat is taken (its seat trigger raises P0001). */
export function isSeatsFullError(err: unknown): boolean {
  return err instanceof StoreError && err.code === "P0001";
}

export async function removeTeamMember(ownerId: string, email: string, admin: Admin = createAdminClient()) {
  const { error } = await admin.from("team_members").delete().eq("owner_id", ownerId).eq("email", email);
  fail("remove member", error);
}

/**
 * Billing rows of every owner whose Team lists this email, with their tester
 * access (a Team tester's seats count while it runs, as in effective_plan()).
 */
export async function teamOwnersFor(email: string, admin: Admin = createAdminClient()): Promise<BillingRow[]> {
  const { data: links, error } = await admin
    .from("team_members")
    .select("owner_id")
    .eq("email", email.toLowerCase());
  fail("find teams", error);
  const ids = ((links as { owner_id: string }[]) ?? []).map((l) => l.owner_id);
  if (ids.length === 0) return [];
  const [{ data, error: e2 }, testers] = await Promise.all([
    admin.from("profiles").select(COLUMNS).in("id", ids),
    admin.from("tester_access").select("user_id, team_until, pro_until").in("user_id", ids),
  ]);
  fail("read team owners", e2);
  // Without the tester table (migration not run yet) owners count as before.
  const testerRows = ((testers?.error ? null : testers?.data) ?? []) as { user_id: string }[];
  const tester = new Map<string, unknown>(testerRows.map((t) => [t.user_id, t]));
  return ((data as BillingRow[]) ?? []).map((row) => ({ ...row, tester: parseTesterAccess(tester.get(row.id)) }));
}
