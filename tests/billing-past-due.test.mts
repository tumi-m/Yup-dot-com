// A renewal that failed left the subscription in Paystack's "attention"
// status, which Paystack charges again on the next payment date. Once the
// 3-day grace ran out, Billing dropped it: no Update card, no Manage
// subscription (the manage route refused too), and a second subscription
// could start beside it. It now stays live and manageable until cancelled.
import { readFileSync } from "node:fs";
import {
  applyCharge, handlePaystackEvent, hasLiveSubscription, ownPlan, resolveAccess, summarize,
  type BillingPatch, type BillingRow, type BillingStore, type EventDeps,
} from "../lib/billing.ts";
import { cardOffer, planStatus, subscribeBlock } from "../lib/billing-ui.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const USER = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d";
const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-18T08:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

function row(extra: Partial<BillingRow> = {}): BillingRow {
  return {
    id: USER, email: "u@x.co", subscription_plan: "pro", subscription_status: "attention",
    current_period_end: ago(4), prepaid_plan: null, paid_until: null, paystack_customer_code: "CUS_u",
    paystack_subscription_code: "SUB_A", paystack_email_token: "tok", ...extra,
  };
}
function view(r: BillingRow, at = now) {
  const access = resolveAccess({ own: r, emailVerified: true, teamOwners: [] }, at);
  return { plan: access.plan, billing: summarize(r, access, at) };
}

// Past due, 4 days after the period ended: access is gone, the subscription isn't.
{
  const r = row();
  const v = view(r);
  const sub = v.billing.subscription;
  check("past due after the grace: on Free", v.plan === "free" && ownPlan(r, now) === "free");
  check("…but Paystack may still charge it", hasLiveSubscription(r, now) && sub?.live === true && sub.active === false, sub);
  check("…so it can still be managed (Update card / cancel)", sub?.manageable === true && sub.pastDue === true, sub);
  check("a second Pro subscription is refused",
    subscribeBlock("pro", v.billing) === "Your Pro payment failed. Update your card on the Billing page.",
    subscribeBlock("pro", v.billing));
  check("so is a Team one, until Pro is cancelled",
    /^To switch to Team, cancel Pro under Manage subscription/.test(subscribeBlock("team", v.billing) ?? ""),
    subscribeBlock("team", v.billing));
  check("the Pro card has no subscribe button", cardOffer("pro", v.plan, v.billing).main === "blocked");
  check("paying once for Team says Pro still renews",
    cardOffer("team", v.plan, v.billing).payOnceNote === "Your Pro subscription still renews. Cancel it under Manage subscription.",
    cardOffer("team", v.plan, v.billing).payOnceNote);
  check("no past renewal date under the plan name", planStatus(v.billing).length === 0, planStatus(v.billing));

  const later = view(r, new Date(now.getTime() + 60 * DAY));
  check("still live two months on", later.billing.subscription?.live === true && later.billing.subscription.manageable);
}

// An active subscription past its date (a renewal we haven't heard about) is live too.
{
  const v = view(row({ subscription_status: "active", current_period_end: ago(10) }));
  check("active past its date: live, manageable, no second subscription",
    v.billing.subscription?.live === true && v.billing.subscription.manageable && subscribeBlock("pro", v.billing) === "You already subscribe to Pro.");
}

// Cancelled, or never confirmed by Paystack: nothing left to charge.
{
  for (const status of ["non-renewing", "cancelled", "complete"] as const) {
    const v = view(row({ subscription_status: status }));
    check(`${status} after its end: not live, can subscribe again`,
      v.billing.subscription?.live === false && !v.billing.subscription.manageable && subscribeBlock("pro", v.billing) === null,
      v.billing.subscription);
  }
  const v = view(row({ paystack_subscription_code: null, paystack_email_token: null }));
  check("past due without a subscription code: not kept live past the grace",
    v.billing.subscription?.live === false && subscribeBlock("pro", v.billing) === null, v.billing.subscription);
}

// In the grace period nothing changes: past due, still Pro.
{
  const v = view(row({ current_period_end: ago(1) }));
  check("in the grace: still Pro, live and manageable",
    v.plan === "pro" && v.billing.subscription?.active === true && v.billing.subscription.live && v.billing.subscription.manageable);
}

// Through the webhooks: the renewal fails, the grace passes, Paystack's next try succeeds.
{
  const db = new Map<string, BillingRow>([[USER, row({
    subscription_status: null, current_period_end: null, paystack_subscription_code: null, paystack_email_token: null,
  })]]);
  const events = new Set<string>();
  const store: BillingStore = {
    async claimEvent(k) { if (events.has(k)) return false; events.add(k); return true; },
    async releaseEvent(k) { events.delete(k); },
    async getRow(id) { return { ...db.get(id)! }; },
    async findUserId(by) {
      for (const r of db.values()) {
        if (by.subscriptionCode ? r.paystack_subscription_code === by.subscriptionCode : r.paystack_customer_code === by.customerCode) return r.id;
      }
      return null;
    },
    async updateRow(id, p: BillingPatch) { const { plan: _p, ...rest } = p; db.set(id, { ...db.get(id)!, ...rest }); },
  };
  let clock = new Date("2026-09-01T08:00:00Z");
  const deps: EventDeps = { store, planForCode: (c) => (c === "PLN_pro" ? "pro" : null), now: () => clock };
  const deliver = (event: string, data: unknown) => {
    const raw = JSON.stringify({ event, data });
    return handlePaystackEvent(JSON.parse(raw), raw, deps);
  };
  const customer = { customer_code: "CUS_u", email: "u@x.co" };
  await applyCharge({
    status: "success", reference: "pw_first", amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: "PLN_pro", customer, metadata: { user_id: USER, plan: "pro", mode: "subscription" },
  }, deps);
  await deliver("subscription.create", {
    subscription_code: "SUB_A", email_token: "tok", status: "active", next_payment_date: "2026-10-01T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer,
  });
  clock = new Date("2026-10-01T09:00:00Z");
  await deliver("invoice.payment_failed", { subscription: { subscription_code: "SUB_A", status: "attention" }, customer });
  clock = new Date("2026-10-18T08:00:00Z");
  const late = view(db.get(USER)!, clock);
  check("17 days after the failed renewal: Free, but manageable and blocking a second subscription",
    late.plan === "free" && late.billing.subscription?.manageable === true && subscribeBlock("pro", late.billing) !== null,
    late.billing.subscription);
  clock = new Date("2026-11-01T08:30:00Z");
  const retry = await applyCharge({
    status: "success", reference: "T_retry", amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: { plan_code: "PLN_pro" }, customer, metadata: "",
  }, deps);
  const back = view(db.get(USER)!, clock);
  check("Paystack's next try succeeds: Pro again, renewing",
    retry.status === "applied" && back.plan === "pro" && back.billing.subscription?.status === "active" &&
      JSON.stringify(planStatus(back.billing)) === JSON.stringify(["Renews 1 Dec 2026"]), back.billing);
}

// The page and the manage route go by the same summary.
{
  const page = readFileSync(new URL("../app/settings/billing/page.tsx", import.meta.url), "utf8");
  check("Billing shows Payment failed while the subscription is live", /sub\?\.pastDue && sub\.live &&/.test(page));
  check("Billing offers Manage subscription whenever it's manageable", /\{sub\?\.manageable && <ManageBillingButton \/>\}/.test(page));
  check("no Upgrade section beside a live subscription", /!sub\?\.active && !sub\?\.live && billing\.source !== "prepaid"/.test(page));
  const manage = readFileSync(new URL("../app/api/billing/manage/route.ts", import.meta.url), "utf8");
  check("the manage route allows what the page offers", /profile\.billing\.subscription\?\.manageable/.test(manage) &&
    !/subscriptionActive/.test(manage));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll past-due subscription checks passed.");
