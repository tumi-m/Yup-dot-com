// A cancel (subscription.not_renew) that Paystack delivered before its
// subscription.create had been recorded was claimed and dropped as "stale",
// and the retried create then set the subscription back to active, so
// Billing said "Renews" for a cancelled subscription. An event for a
// subscription whose create hasn't landed now applies, and a late create
// keeps what came after it. Events for an older subscription still don't
// touch the current one.
import {
  applyCharge, handlePaystackEvent, resolveAccess, summarize,
  type BillingPatch, type BillingRow, type BillingStore, type EventDeps,
} from "../lib/billing.ts";
import { planStatus } from "../lib/billing-ui.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const USER = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d";
const customer = { customer_code: "CUS_u", email: "u@x.co" };
const clock = new Date("2026-10-18T08:00:00Z");

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
    async findUserId(by) {
      for (const r of db.values()) {
        if (by.subscriptionCode) { if (r.paystack_subscription_code === by.subscriptionCode) return r.id; }
        else if (by.customerCode) { if (r.paystack_customer_code === by.customerCode) return r.id; }
        else if (r.email === by.email) return r.id;
      }
      return null;
    },
    async updateRow(id, p: BillingPatch) { const { plan: _p, ...rest } = p; db.set(id, { ...db.get(id)!, ...rest }); },
  };
  const deps: EventDeps = { store, planForCode: (c) => (c === "PLN_pro" ? "pro" : null), now: () => clock };
  const deliver = (event: string, data: unknown) => {
    const raw = JSON.stringify({ event, data });
    return handlePaystackEvent(JSON.parse(raw), raw, deps);
  };
  const firstCharge = (ref: string) => applyCharge({
    status: "success", reference: ref, amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: "PLN_pro", customer, metadata: JSON.stringify({ user_id: USER, plan: "pro", mode: "subscription" }),
  }, deps);
  const lines = () => {
    const r = db.get(USER)!;
    return planStatus(summarize(r, resolveAccess({ own: r, emailVerified: true, teamOwners: [] }, clock), clock));
  };
  return { db, events, deliver, firstCharge, lines, row: () => db.get(USER)! };
}

const create = (code: string) => ({
  subscription_code: code, status: "active", email_token: `tok_${code}`, next_payment_date: "2026-11-18T08:00:00.000Z",
  plan: { plan_code: "PLN_pro" }, customer,
});

// The reported order: first charge on return, the create delivery failed (500) and waits for
// Paystack's retry, the customer cancels from Paystack's email meanwhile.
{
  const s = setup();
  await s.firstCharge("pw_first");
  const cancel = await s.deliver("subscription.not_renew", { subscription_code: "SUB_B", status: "non-renewing", customer });
  check("cancel before create: applied", cancel.status === "applied" && s.row().subscription_status === "non-renewing" &&
    s.row().paystack_subscription_code === "SUB_B", s.row());
  const late = await s.deliver("subscription.create", create("SUB_B"));
  check("the retried create keeps the cancel", late.status === "applied" && s.row().subscription_status === "non-renewing" &&
    s.row().paystack_email_token === "tok_SUB_B", s.row());
  check("Billing says Ends, not Renews", JSON.stringify(s.lines()) === JSON.stringify(["Ends 18 Nov 2026"]), s.lines());
}

// Ended or past due before the create landed: the create doesn't undo it either.
for (const [event, data, status] of [
  ["subscription.disable", { subscription_code: "SUB_B", status: "complete", customer }, "complete"],
  ["invoice.payment_failed", { subscription: { subscription_code: "SUB_B", status: "attention" }, customer }, "attention"],
] as const) {
  const s = setup();
  await s.firstCharge("pw_first");
  const r = await s.deliver(event, data);
  await s.deliver("subscription.create", create("SUB_B"));
  check(`${event} before create: ${status} is kept`, r.status === "applied" && s.row().subscription_status === status, s.row());
}

// The usual order is unchanged.
{
  const s = setup();
  await s.firstCharge("pw_first");
  await s.deliver("subscription.create", create("SUB_B"));
  check("create after the first charge: active, renewing", s.row().subscription_status === "active" &&
    JSON.stringify(s.lines()) === JSON.stringify(["Renews 18 Nov 2026"]), s.lines());
  await s.deliver("subscription.not_renew", { subscription_code: "SUB_B", status: "non-renewing", customer });
  check("then a cancel: non-renewing", s.row().subscription_status === "non-renewing");
}

// The create lands before the first charge (the webhook beat the return): the code stays.
{
  const s = setup();
  await s.deliver("subscription.create", create("SUB_B"));
  await s.firstCharge("pw_first");
  check("create, then the first charge: code and status kept",
    s.row().paystack_subscription_code === "SUB_B" && s.row().subscription_status === "active", s.row());
}

// Subscribing again after an older subscription ended: its code no longer counts.
{
  const s = setup({
    subscription_plan: "pro", subscription_status: "complete", current_period_end: "2026-09-01T08:00:00.000Z",
    paystack_customer_code: "CUS_u", paystack_subscription_code: "SUB_A", paystack_email_token: "tok_SUB_A",
  });
  await s.firstCharge("pw_again");
  const sum = summarize(s.row(), resolveAccess({ own: s.row(), emailVerified: true, teamOwners: [] }, clock), clock);
  check("new first charge: the old code is dropped, so Manage doesn't open the ended subscription",
    s.row().paystack_subscription_code === null && sum.subscription?.manageable === false && sum.plan === "pro", s.row());
  const cancel = await s.deliver("subscription.not_renew", { subscription_code: "SUB_B", status: "non-renewing", customer });
  await s.deliver("subscription.create", create("SUB_B"));
  check("a cancel of the new one before its create still counts",
    cancel.status === "applied" && s.row().subscription_status === "non-renewing" && s.row().paystack_subscription_code === "SUB_B", s.row());
}

// A late event from an older subscription is still ignored, and its claim isn't kept.
{
  const s = setup();
  await s.firstCharge("pw_first");
  await s.deliver("subscription.create", create("SUB_B"));
  const data = { subscription_code: "SUB_OLD", status: "cancelled", customer };
  const stale = await s.deliver("subscription.disable", data);
  check("event for another subscription: ignored", stale.status === "ignored" && s.row().subscription_status === "active" &&
    s.row().paystack_subscription_code === "SUB_B", stale);
  const again = await s.deliver("subscription.disable", data);
  check("…and looked at again if delivered again", again.status === "ignored" && s.events.size === 2, { again, events: [...s.events] });
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll subscription event order checks passed.");
