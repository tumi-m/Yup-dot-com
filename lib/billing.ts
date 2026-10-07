/**
 * Billing rules, independent of Next.js, Supabase and the network so they can
 * be tested directly: who is on which plan right now, Paystack webhook
 * signatures, and how each Paystack event changes a customer's billing row.
 *
 * Access is decided at read time from dates stored on the profile, so an
 * expired prepaid term or a lapsed subscription stops granting a plan the
 * moment it ends — no scheduled job is needed.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  CURRENCY,
  TEAM_MEMBER_LIMIT,
  PLANS,
  isPaidPlan,
  isPrepaidMonths,
  prepaidPrice,
  toSubunit,
  type PaidPlanId,
  type PrepaidMonths,
} from "./plans";
import type { PlanId } from "./types";

// ---------------------------------------------------------------------------
// Billing state
// ---------------------------------------------------------------------------

/** Paystack subscription statuses we store. */
export type SubscriptionStatus =
  | "active"
  | "non-renewing"
  | "attention"
  | "cancelled"
  | "complete";

/** The billing columns of `public.profiles`. Only the service role writes them. */
export interface BillingRow {
  id: string;
  email: string | null;
  subscription_plan: PaidPlanId | null;
  subscription_status: SubscriptionStatus | null;
  /** Paystack's next_payment_date: access runs to here. */
  current_period_end: string | null;
  prepaid_plan: PaidPlanId | null;
  paid_until: string | null;
  paystack_customer_code: string | null;
  paystack_subscription_code: string | null;
  paystack_email_token: string | null;
}

export const BILLING_COLUMNS = [
  "id",
  "email",
  "subscription_plan",
  "subscription_status",
  "current_period_end",
  "prepaid_plan",
  "paid_until",
  "paystack_customer_code",
  "paystack_subscription_code",
  "paystack_email_token",
] as const satisfies readonly (keyof BillingRow)[];

export type BillingPatch = Partial<Omit<BillingRow, "id" | "email">> & { plan?: PlanId };

/**
 * A renewal is charged on the period end date, and Paystack's webhook can
 * trail it. Active and past-due subscriptions keep access this long past the
 * end so a renewal in flight never locks anyone out. Cancelled ones end on
 * the date they were paid up to.
 */
export const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

const RANK: Record<PlanId, number> = { free: 0, pro: 1, team: 2 };
const best = (a: PlanId, b: PlanId): PlanId => (RANK[b] > RANK[a] ? b : a);

const time = (iso: string | null | undefined) => {
  if (!iso) return NaN;
  return new Date(iso).getTime();
};

export function subscriptionActive(row: BillingRow | null, now: Date): boolean {
  if (!row || !isPaidPlan(row.subscription_plan)) return false;
  const end = time(row.current_period_end);
  if (Number.isNaN(end)) return false;
  switch (row.subscription_status) {
    case "active":
    case "attention":
      return end + RENEWAL_GRACE_MS > now.getTime();
    case "non-renewing":
    case "cancelled":
    case "complete":
      return end > now.getTime();
    default:
      return false;
  }
}

export function prepaidActive(row: BillingRow | null, now: Date): boolean {
  if (!row || !isPaidPlan(row.prepaid_plan)) return false;
  return time(row.paid_until) > now.getTime();
}

/** The plan a user pays for themselves (ignoring team membership). */
export function ownPlan(row: BillingRow | null, now: Date): PlanId {
  let plan: PlanId = "free";
  if (subscriptionActive(row, now)) plan = best(plan, row!.subscription_plan!);
  if (prepaidActive(row, now)) plan = best(plan, row!.prepaid_plan!);
  return plan;
}

export type PlanSource = "subscription" | "prepaid" | "team" | null;

export interface Access {
  plan: PlanId;
  source: PlanSource;
  /** Set when the plan comes from someone else's Team. */
  teamOwnerId: string | null;
}

/**
 * Effective plan for a user. `teamOwners` are the billing rows of every user
 * who listed this user's email as a Team member; they only count when the
 * email is verified (otherwise anyone could sign up as someone else's
 * address) and while the owner's own Team plan is active.
 */
export function resolveAccess(
  input: { own: BillingRow | null; emailVerified: boolean; teamOwners: BillingRow[] },
  now: Date
): Access {
  const { own } = input;
  const sub = subscriptionActive(own, now) ? own!.subscription_plan! : "free";
  const pre = prepaidActive(own, now) ? own!.prepaid_plan! : "free";
  const mine = best(sub, pre);
  if (mine === "team") {
    return { plan: "team", source: RANK[sub] >= RANK[pre] ? "subscription" : "prepaid", teamOwnerId: null };
  }
  if (input.emailVerified) {
    const owner = input.teamOwners.find((o) => o.id !== own?.id && ownPlan(o, now) === "team");
    if (owner) return { plan: "team", source: "team", teamOwnerId: owner.id };
  }
  if (mine === "free") return { plan: "free", source: null, teamOwnerId: null };
  return { plan: mine, source: RANK[sub] >= RANK[pre] ? "subscription" : "prepaid", teamOwnerId: null };
}

/** What the billing page needs to know, serialisable for client components. */
export interface BillingSummary {
  plan: PlanId;
  source: PlanSource;
  subscription: {
    plan: PaidPlanId;
    status: SubscriptionStatus;
    periodEnd: string | null;
    active: boolean;
    pastDue: boolean;
    renews: boolean;
    manageable: boolean;
  } | null;
  prepaid: { plan: PaidPlanId; paidUntil: string; active: boolean } | null;
  teamOwnerEmail: string | null;
}

export function summarize(
  row: BillingRow | null,
  access: Access,
  now: Date,
  teamOwnerEmail: string | null = null
): BillingSummary {
  const subActive = subscriptionActive(row, now);
  const subscription =
    row && isPaidPlan(row.subscription_plan) && row.subscription_status
      ? {
          plan: row.subscription_plan,
          status: row.subscription_status,
          periodEnd: row.current_period_end,
          active: subActive,
          pastDue: row.subscription_status === "attention",
          renews: row.subscription_status === "active" || row.subscription_status === "attention",
          manageable: !!row.paystack_subscription_code && subActive,
        }
      : null;
  const prepaid =
    row && isPaidPlan(row.prepaid_plan) && row.paid_until
      ? { plan: row.prepaid_plan, paidUntil: row.paid_until, active: prepaidActive(row, now) }
      : null;
  return { plan: access.plan, source: access.source, subscription, prepaid, teamOwnerEmail };
}

export const FREE_SUMMARY: BillingSummary = {
  plan: "free",
  source: null,
  subscription: null,
  prepaid: null,
  teamOwnerEmail: null,
};

/**
 * Whether a new subscription checkout should be refused: Paystack would
 * otherwise run two subscriptions side by side.
 */
export function hasLiveSubscription(row: BillingRow | null, now: Date): boolean {
  if (!row?.subscription_status) return false;
  return subscriptionActive(row, now) && row.subscription_status !== "cancelled" && row.subscription_status !== "complete";
}

/** Calendar months in UTC, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

// ---------------------------------------------------------------------------
// Team seats
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export type SeatError = "invalid" | "self" | "duplicate" | "full" | "not-team";

/** Validates adding a member to a Team owner's list. */
export function checkNewMember(
  input: { ownerPlan: PlanId; ownerEmail: string | null; members: string[]; email: unknown }
): { ok: true; email: string } | { ok: false; error: SeatError } {
  if (input.ownerPlan !== "team") return { ok: false, error: "not-team" };
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, error: "invalid" };
  if (input.ownerEmail && email === input.ownerEmail.toLowerCase()) return { ok: false, error: "self" };
  if (input.members.includes(email)) return { ok: false, error: "duplicate" };
  if (input.members.length >= TEAM_MEMBER_LIMIT) return { ok: false, error: "full" };
  return { ok: true, email };
}

export const SEAT_ERRORS: Record<SeatError, string> = {
  invalid: "Enter a valid email.",
  self: "You already have a seat.",
  duplicate: "Already on your team.",
  full: "All seats are taken.",
  "not-team": "Seats come with the Team plan.",
};

// ---------------------------------------------------------------------------
// Paystack webhooks
// ---------------------------------------------------------------------------

/**
 * Paystack signs the raw request body with HMAC-SHA512 keyed by the secret
 * key and sends the hex digest in `x-paystack-signature`.
 */
export function signPaystackBody(rawBody: string | Uint8Array, secret: string): string {
  return createHmac("sha512", secret).update(rawBody).digest("hex");
}

export function verifyPaystackSignature(
  rawBody: string | Uint8Array,
  signature: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!signature || !secret) return false;
  const expected = Buffer.from(signPaystackBody(rawBody, secret), "hex");
  if (!/^[0-9a-f]+$/i.test(signature.trim())) return false;
  const given = Buffer.from(signature.trim(), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Where billing state lives. Supabase in production, an in-memory fake in tests. */
export interface BillingStore {
  /** Records an event as processed. False when it already was. */
  claimEvent(key: string, type: string): Promise<boolean>;
  /** Undoes a claim after a failure so Paystack's retry is processed. */
  releaseEvent(key: string): Promise<void>;
  getRow(userId: string): Promise<BillingRow | null>;
  findUserId(by: { customerCode?: string; subscriptionCode?: string; email?: string }): Promise<string | null>;
  updateRow(userId: string, patch: BillingPatch): Promise<void>;
}

export interface EventDeps {
  store: BillingStore;
  /** Maps a Paystack plan code (PLN_…) to our plan. */
  planForCode: (code: string | null | undefined) => PaidPlanId | null;
  now?: () => Date;
}

export type EventResult =
  | { status: "applied"; userId: string; key: string }
  | { status: "duplicate"; key: string }
  | { status: "ignored"; reason: string };

/** Paystack returns metadata as an object, or as the string it was sent as. */
export function parseMetadata(meta: unknown): Record<string, unknown> {
  if (typeof meta === "string") {
    try {
      const v = JSON.parse(meta);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function planCodeOf(tx: Json): string | null {
  if (typeof tx.plan === "string" && tx.plan) return tx.plan;
  if (tx.plan && typeof tx.plan.plan_code === "string") return tx.plan.plan_code;
  if (tx.plan_object && typeof tx.plan_object.plan_code === "string") return tx.plan_object.plan_code;
  return null;
}

const iso = (d: Date) => d.toISOString();
const later = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : time(a) >= time(b) ? a : b;

/** Metadata we attach at checkout. */
export interface CheckoutMetadata {
  user_id: string;
  plan: PaidPlanId;
  mode: "subscription" | "once";
  months?: PrepaidMonths;
}

/**
 * Applies a successful charge — from the `charge.success` webhook or from
 * verifying the reference on return from checkout. Both paths share the
 * idempotency key `charge:<reference>`, so a payment is applied once however
 * many times it is reported.
 */
export async function applyCharge(tx: Json, deps: EventDeps): Promise<EventResult> {
  const now = deps.now?.() ?? new Date();
  if (!tx || tx.status !== "success") return { status: "ignored", reason: "not successful" };
  if (typeof tx.reference !== "string" || !tx.reference) return { status: "ignored", reason: "no reference" };
  if (tx.currency && tx.currency !== CURRENCY) return { status: "ignored", reason: "currency" };

  const meta = parseMetadata(tx.metadata);
  const metaUser = typeof meta.user_id === "string" && UUID_RE.test(meta.user_id) ? meta.user_id : null;
  const customerCode: string | null = tx.customer?.customer_code ?? null;
  const amount = Number(tx.amount);

  let kind: { mode: "once"; plan: PaidPlanId; months: PrepaidMonths } | { mode: "subscription"; plan: PaidPlanId };
  if (meta.mode === "once") {
    const months = Number(meta.months);
    if (!isPaidPlan(meta.plan) || !isPrepaidMonths(months)) return { status: "ignored", reason: "bad metadata" };
    if (amount !== toSubunit(prepaidPrice(meta.plan, months))) return { status: "ignored", reason: "amount mismatch" };
    kind = { mode: "once", plan: meta.plan, months };
  } else {
    const plan = deps.planForCode(planCodeOf(tx));
    if (!plan) return { status: "ignored", reason: "no known plan" };
    if (!(amount >= toSubunit(PLANS[plan].priceMonthly))) return { status: "ignored", reason: "amount mismatch" };
    kind = { mode: "subscription", plan };
  }

  const userId =
    metaUser ?? (customerCode ? await deps.store.findUserId({ customerCode }) : null);
  if (!userId) return { status: "ignored", reason: "unknown customer" };

  const key = `charge:${tx.reference}`;
  if (!(await deps.store.claimEvent(key, "charge.success"))) return { status: "duplicate", key };
  try {
    const row = await deps.store.getRow(userId);
    if (!row) throw new Error(`No profile for ${userId}`);
    const patch: BillingPatch = { plan: kind.plan };
    if (customerCode) patch.paystack_customer_code = customerCode;

    if (kind.mode === "once") {
      // The same plan extends from whenever the current term ends; a different
      // plan starts now.
      const running = row.prepaid_plan === kind.plan && prepaidActive(row, now);
      const base = running ? new Date(row.paid_until!) : now;
      patch.prepaid_plan = kind.plan;
      patch.paid_until = iso(addMonths(base, kind.months));
    } else {
      const paidAt = tx.paid_at ? new Date(tx.paid_at) : now;
      const end = iso(addMonths(Number.isNaN(paidAt.getTime()) ? now : paidAt, 1));
      patch.subscription_plan = kind.plan;
      patch.current_period_end = later(row.current_period_end, end);
      const firstCharge = metaUser !== null;
      const st = row.subscription_status;
      if (firstCharge || st === null || st === "active" || st === "attention") {
        patch.subscription_status = "active";
      }
    }
    await deps.store.updateRow(userId, patch);
    return { status: "applied", userId, key };
  } catch (err) {
    await deps.store.releaseEvent(key);
    throw err;
  }
}

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/**
 * Applies one verified webhook delivery. Paystack retries until it gets a
 * 200, and may deliver an event more than once, so every event is recorded
 * under a key and a repeat is a no-op.
 */
export async function handlePaystackEvent(
  event: { event?: unknown; data?: unknown },
  rawBody: string | Uint8Array,
  deps: EventDeps
): Promise<EventResult> {
  const type = typeof event?.event === "string" ? event.event : "";
  const data = (event?.data && typeof event.data === "object" ? event.data : {}) as Json;

  if (type === "charge.success") return applyCharge(data, deps);

  const handlers: Record<string, () => Promise<{ code: string | null; userId: string | null; patch: (row: BillingRow) => BillingPatch | null }>> = {
    "subscription.create": async () => {
      const code: string | null = data.subscription_code ?? null;
      const plan = deps.planForCode(data.plan?.plan_code);
      const userId = await findCustomer(deps.store, data.customer, code);
      return {
        code,
        userId,
        patch: (row) =>
          plan && code
            ? {
                plan,
                subscription_plan: plan,
                subscription_status: statusOf(data.status) ?? "active",
                paystack_subscription_code: code,
                paystack_email_token: data.email_token ?? row.paystack_email_token,
                paystack_customer_code: data.customer?.customer_code ?? row.paystack_customer_code,
                current_period_end: data.next_payment_date ?? row.current_period_end,
              }
            : null,
      };
    },
    "subscription.not_renew": async () => subscriptionChange(data, deps.store, () => ({ subscription_status: "non-renewing" })),
    "subscription.disable": async () =>
      subscriptionChange(data, deps.store, () => ({
        subscription_status: statusOf(data.status) === "complete" ? "complete" : "cancelled",
      })),
    "invoice.payment_failed": async () =>
      subscriptionChange(data.subscription ?? {}, deps.store, () => ({ subscription_status: "attention" }), data.customer),
    "invoice.update": async () =>
      subscriptionChange(data.subscription ?? {}, deps.store, (row) => {
        const sub = data.subscription ?? {};
        if (data.paid === true || data.status === "success") {
          return {
            subscription_status: row.subscription_status === "attention" ? "active" : row.subscription_status,
            current_period_end: later(row.current_period_end, sub.next_payment_date ?? null),
          };
        }
        if (sub.status === "attention") return { subscription_status: "attention" };
        return null;
      }, data.customer),
  };

  const handler = handlers[type];
  if (!handler) return { status: "ignored", reason: `unhandled ${type || "event"}` };

  const { code, userId, patch } = await handler();
  if (!code) return { status: "ignored", reason: "no subscription code" };
  if (!userId) return { status: "ignored", reason: "unknown customer" };

  const key = `${type}:${sha256(rawBody)}`;
  if (!(await deps.store.claimEvent(key, type))) return { status: "duplicate", key };
  try {
    const row = await deps.store.getRow(userId);
    if (!row) throw new Error(`No profile for ${userId}`);
    // Only the subscription we know about may change state: a late event
    // from an older, replaced subscription must not touch the current one.
    if (type !== "subscription.create" && row.paystack_subscription_code !== code) {
      return { status: "ignored", reason: "stale subscription" };
    }
    const p = patch(row);
    if (!p) return { status: "ignored", reason: "nothing to change" };
    await deps.store.updateRow(userId, p);
    return { status: "applied", userId, key };
  } catch (err) {
    await deps.store.releaseEvent(key);
    throw err;
  }
}

function statusOf(s: unknown): SubscriptionStatus | null {
  return s === "active" || s === "non-renewing" || s === "attention" || s === "cancelled" || s === "complete"
    ? s
    : null;
}

async function findCustomer(store: BillingStore, customer: Json | undefined, subscriptionCode: string | null) {
  if (subscriptionCode) {
    const id = await store.findUserId({ subscriptionCode });
    if (id) return id;
  }
  if (customer?.customer_code) {
    const id = await store.findUserId({ customerCode: customer.customer_code });
    if (id) return id;
  }
  const email = normalizeEmail(customer?.email);
  return email ? store.findUserId({ email }) : null;
}

async function subscriptionChange(
  sub: Json,
  store: BillingStore,
  patch: (row: BillingRow) => BillingPatch | null,
  customer?: Json
) {
  const code: string | null = sub.subscription_code ?? null;
  const userId = code ? await findCustomer(store, customer ?? sub.customer, code) : null;
  return { code, userId, patch };
}
