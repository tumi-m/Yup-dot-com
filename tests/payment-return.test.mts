// On return from checkout the page said "Payment received. You're on Free.":
// it showed the plan from before the payment until the page refreshed, and
// for good when the webhook held the charge and hadn't written it yet (the
// return reported "duplicate" as success and stopped checking). The return
// now waits until the row grants what was bought and names the plan in use.
import { readFileSync } from "node:fs";
import {
  applyCharge, confirmCharge,
  type BillingPatch, type BillingRow, type BillingStore, type EventDeps,
} from "../lib/billing.ts";
import { paymentOutcome, paymentPlanName } from "../lib/billing-ui.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const USER = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d";
let clock = new Date("2026-10-18T08:00:00Z");

function setup(extra: Partial<BillingRow> = {}) {
  const db = new Map<string, BillingRow>([[USER, {
    id: USER, email: "u@x.co", subscription_plan: null, subscription_status: null, current_period_end: null,
    prepaid_plan: null, paid_until: null, paystack_customer_code: null, paystack_subscription_code: null,
    paystack_email_token: null, ...extra,
  }]]);
  const events = new Set<string>();
  const store: BillingStore = {
    async claimEvent(k) { if (events.has(k)) return false; events.add(k); return true; },
    async releaseEvent(k) { events.delete(k); },
    async getRow(id) { return { ...db.get(id)! }; },
    async findUserId() { return USER; },
    async updateRow(id, p: BillingPatch) { const { plan: _p, ...rest } = p; db.set(id, { ...db.get(id)!, ...rest }); },
  };
  const deps: EventDeps = { store, planForCode: (c) => (c === "PLN_pro" ? "pro" : null), now: () => clock };
  return { db, events, store, deps };
}
const once = (ref: string, plan = "pro", months = 1, amount = 4900) => ({
  status: "success", reference: ref, amount, currency: "ZAR", paid_at: clock.toISOString(),
  customer: { customer_code: "CUS_u" }, metadata: { user_id: USER, plan, mode: "once", months },
});

// The return comes first: the charge is applied here, and the answer names the new plan.
{
  const s = setup();
  const r = await confirmCharge(once("pw_ret"), USER, "free", s.deps);
  check("applied on return: success, on Pro", r.status === "success" && r.plan === "pro", r);
}

// The webhook holds the charge and is still writing it: ask again, don't report Free.
{
  const s = setup();
  await s.store.claimEvent("charge:pw_race", "charge.success");
  const r1 = await confirmCharge(once("pw_race"), USER, "free", s.deps);
  check("webhook still writing: pending, not success", r1.status === "pending", r1);
  check("which the page reads as 'ask again'", paymentOutcome(202, "pending") === "retry");
  // The webhook finishes.
  await s.store.updateRow(USER, { prepaid_plan: "pro", paid_until: "2026-11-18T08:00:00.000Z" });
  const r2 = await confirmCharge(once("pw_race"), USER, "free", s.deps);
  check("once it's written: success, on Pro", r2.status === "success" && r2.plan === "pro", r2);
}

// The webhook failed and let go of the charge: the return applies it.
{
  const s = setup();
  await s.store.claimEvent("charge:pw_drop", "charge.success");
  check("held: pending", (await confirmCharge(once("pw_drop"), USER, "free", s.deps)).status === "pending");
  await s.store.releaseEvent("charge:pw_drop");
  const r = await confirmCharge(once("pw_drop"), USER, "free", s.deps);
  check("released: applied here, on Pro", r.status === "success" && r.plan === "pro" && s.db.get(USER)!.prepaid_plan === "pro", r);
}

// Already applied by the webhook before the return: success straight away.
{
  const s = setup();
  await applyCharge(once("pw_done"), s.deps);
  const r = await confirmCharge(once("pw_done"), USER, "pro", s.deps);
  check("webhook already done: success, on Pro", r.status === "success" && r.plan === "pro", r);
}

// A subscription's first charge, held by the webhook.
{
  const s = setup();
  const tx = {
    status: "success", reference: "pw_sub", amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: "PLN_pro", customer: { customer_code: "CUS_u" }, metadata: { user_id: USER, plan: "pro", mode: "subscription" },
  };
  await s.store.claimEvent("charge:pw_sub", "charge.success");
  check("subscription, webhook still writing: pending", (await confirmCharge(tx, USER, "free", s.deps)).status === "pending");
  await s.store.updateRow(USER, { subscription_plan: "pro", subscription_status: "active", current_period_end: "2026-11-18T08:00:00.000Z" });
  const r = await confirmCharge(tx, USER, "free", s.deps);
  check("subscription written: success, on Pro", r.status === "success" && r.plan === "pro", r);
}

// The plan named is the one in use: a Team seat outranks Pro bought for oneself.
{
  const s = setup();
  const r = await confirmCharge(once("pw_seat"), USER, "team", s.deps);
  check("Team seat member buys Pro: 'You're on Team'", r.status === "success" && r.plan === "team", r);
}

// Coming back to an old payment link after its term ended doesn't wait forever.
{
  const s = setup();
  const tx = once("pw_old");
  await applyCharge(tx, s.deps);
  clock = new Date("2027-01-18T08:00:00Z");
  const r = await confirmCharge(tx, USER, "free", s.deps);
  check("old link, term over: success, on Free (not 'still processing')", r.status === "success" && r.plan === "free", r);
  clock = new Date("2026-10-18T08:00:00Z");
}

// The page shows the plan from the answer, not the one rendered before the payment.
{
  check("plan names", paymentPlanName("pro") === "Pro" && paymentPlanName("team") === "Team" && paymentPlanName("free") === "Free");
  check("no plan in the answer: no name", paymentPlanName(undefined) === null && paymentPlanName("gold") === null);
  const client = readFileSync(new URL("../components/BillingClient.tsx", import.meta.url), "utf8");
  check("PaymentReturn takes no plan name from the server render",
    /export function PaymentReturn\(\{ reference \}: \{ reference: string \}\)/.test(client) &&
      /plan = paymentPlanName\(data\.plan\)/.test(client));
  const route = readFileSync(new URL("../app/api/billing/verify/route.ts", import.meta.url), "utf8");
  check("verify answers pending while the webhook writes, and names the plan",
    /confirmCharge\(/.test(route) && /status: "pending" \}, 202/.test(route) && /plan: result\.plan/.test(route));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll payment return checks passed.");
