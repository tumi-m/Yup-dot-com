/**
 * What the pricing cards offer and why the checkout refuses, worked out from
 * real billing rows through the same summary the pages use.
 */
import {
  hasLiveSubscription, resolveAccess, summarize, type BillingRow,
} from "../lib/billing.ts";
import {
  cardOffer, payOnceBlock, paymentOutcome, planStatus, subscribeBlock, verifyDelay, waitForPayment, type PaymentOutcome,
} from "../lib/billing-ui.ts";
import type { PaidPlanId } from "../lib/plans.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra: unknown = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? "  — " + JSON.stringify(extra) : ""}`);
};

const USER = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d";
const OWNER = "0f8e7d6c-5b4a-4321-8fed-cba987654321";
const now = new Date("2026-10-17T08:00:00Z");

function row(extra: Partial<BillingRow> = {}, id = USER): BillingRow {
  return {
    id, email: "u@x.co", subscription_plan: null, subscription_status: null, current_period_end: null,
    prepaid_plan: null, paid_until: null, paystack_customer_code: null,
    paystack_subscription_code: "SUB_1", paystack_email_token: null, ...extra,
  };
}
/** The plan and billing summary the pages hand to the cards. */
function viewer(own: BillingRow, teamOwners: BillingRow[] = []) {
  const access = resolveAccess({ own, emailVerified: true, teamOwners }, now);
  return { plan: access.plan, billing: summarize(own, access, now) };
}
const sub = (plan: PaidPlanId, status: BillingRow["subscription_status"], end = "2026-11-17T08:00:00Z") =>
  row({ subscription_plan: plan, subscription_status: status, current_period_end: end });

// Signed out and free: every paid plan can be bought either way.
for (const v of [{ plan: undefined, billing: undefined }, viewer(row())]) {
  for (const p of ["pro", "team"] as const) {
    const o = cardOffer(p, v.plan, v.billing);
    check(`${v.plan ?? "signed out"}: ${p} offers subscribe and pay once`, o.main === "subscribe" && o.payOnce && !o.payOnceNote, o);
  }
}

// Prepaid Pro: Team can be bought once, and the Pro time left carries over.
{
  const v = viewer(row({ prepaid_plan: "pro", paid_until: "2027-10-17T08:00:00Z" }));
  const pro = cardOffer("pro", v.plan, v.billing);
  const team = cardOffer("team", v.plan, v.billing);
  check("prepaid Pro: Pro card is the current plan", pro.main === "current" && !pro.payOnce, pro);
  check("prepaid Pro: Team pay once says the Pro time carries over",
    team.payOnce && team.payOnceNote === "Your Pro time left carries over.", team);
  check("prepaid Pro: checkout allows Team once", payOnceBlock("team", v.billing) === null);
}

// Prepaid Team: Pro is part of it, not an upgrade, and can't be bought once.
{
  const v = viewer(row({ prepaid_plan: "team", paid_until: "2027-10-17T08:00:00Z" }));
  const pro = cardOffer("pro", v.plan, v.billing);
  check("prepaid Team: Pro card says 'Included in Team', no pay once",
    pro.main === "included" && pro.text === "Included in Team" && !pro.payOnce, pro);
  check("prepaid Team: checkout refuses Pro once", payOnceBlock("pro", v.billing) === "Your Team plan already includes Pro.");
  check("prepaid Team: checkout allows extending Team", payOnceBlock("team", v.billing) === null);
}

// Team subscriber: Pro is included too.
{
  const v = viewer(sub("team", "active"));
  const pro = cardOffer("pro", v.plan, v.billing);
  check("Team subscriber: Pro card says 'Included in Team'", pro.main === "included" && !pro.payOnce, pro);
  check("Team subscriber: checkout refuses Pro once and monthly",
    payOnceBlock("pro", v.billing) !== null && subscribeBlock("pro", v.billing) !== null);
}

// Live Pro subscriber: no dead-end "Upgrade to Team"; say how to switch.
{
  const v = viewer(sub("pro", "active"));
  const team = cardOffer("team", v.plan, v.billing);
  check("Pro subscriber: Team card explains the switch instead of a subscribe button",
    team.main === "blocked" && /cancel Pro under Manage subscription/.test(team.text ?? ""), team);
  check("Pro subscriber: Team can still be paid once", team.payOnce && payOnceBlock("team", v.billing) === null);
  check("Pro subscriber: subscribing to Pro again is refused plainly",
    subscribeBlock("pro", v.billing) === "You already subscribe to Pro.");
  const late = viewer(sub("pro", "attention", "2026-10-16T08:00:00Z"));
  check("past-due Pro (in grace) also explains the switch", cardOffer("team", late.plan, late.billing).main === "blocked");
}

// Non-renewing: the subscription runs to its end date first.
{
  const v = viewer(sub("pro", "non-renewing"));
  check("non-renewing Pro: Team waits for the end date",
    subscribeBlock("team", v.billing) === "Your Pro plan ends 17 Nov 2026. Subscribe to Team after that.",
    subscribeBlock("team", v.billing));
}

// Cancelled but paid up: another plan would cut it short, so it waits.
{
  const v = viewer(sub("team", "cancelled", "2026-12-01T08:00:00Z"));
  check("cancelled Team to 1 Dec: no 'Upgrade to Pro'", cardOffer("pro", v.plan, v.billing).main === "included");
  check("cancelled Team to 1 Dec: checkout refuses a Pro subscription",
    subscribeBlock("pro", v.billing) === "Your Team plan ends 1 Dec 2026. Subscribe to Pro after that.",
    subscribeBlock("pro", v.billing));
  check("cancelled Team: subscribing to Team again is allowed", subscribeBlock("team", v.billing) === null);
  const pro = viewer(sub("pro", "complete", "2026-12-01T08:00:00Z"));
  check("completed Pro to 1 Dec: Team card explains, Team once still allowed",
    cardOffer("team", pro.plan, pro.billing).main === "blocked" && cardOffer("team", pro.plan, pro.billing).payOnce);
}

// Ended subscriptions and Team seats don't block anything of the member's own.
{
  const ended = viewer(sub("team", "cancelled", "2026-10-01T08:00:00Z"));
  check("ended subscription: any plan can start", subscribeBlock("pro", ended.billing) === null &&
    cardOffer("pro", ended.plan, ended.billing).main === "subscribe");
  const owner = row({ subscription_plan: "team", subscription_status: "active", current_period_end: "2026-11-17T08:00:00Z" }, OWNER);
  const seat = viewer(row({ paystack_subscription_code: null }), [owner]);
  check("Team seat: Pro card says 'Included in Team'", seat.plan === "team" && cardOffer("pro", seat.plan, seat.billing).main === "included");
  check("Team seat: their own purchases aren't refused",
    payOnceBlock("pro", seat.billing) === null && subscribeBlock("pro", seat.billing) === null);
}

// Whenever Paystack would charge a live subscription, a new one is refused.
{
  const statuses = ["active", "attention", "non-renewing", "cancelled", "complete", null] as const;
  const ends = ["2026-10-10T08:00:00Z", "2026-10-16T08:00:00Z", "2026-11-17T08:00:00Z"];
  let ok = true;
  for (const s of statuses) for (const e of ends) for (const have of ["pro", "team"] as const) {
    const r = sub(have, s, e);
    const b = viewer(r).billing;
    for (const want of ["pro", "team"] as const) {
      if (hasLiveSubscription(r, now) && subscribeBlock(want, b) === null) ok = false;
    }
  }
  check("a live subscription always blocks a second one", ok);
}

// Payment return: "you weren't charged" only when Paystack says so.
{
  check("verify success", paymentOutcome(200, "success") === "success");
  check("abandoned / failed / reversed → not charged",
    ["abandoned", "failed", "reversed"].every((s) => paymentOutcome(200, s) === "failed"));
  check("paid from another account is not 'not charged'", paymentOutcome(404, "other-account") === "other-account");
  check("paid but not applied is not 'not charged'", paymentOutcome(422, "not-applied") === "not-applied");
  check("in flight → retry", ["ongoing", "pending", "processing", "queued"].every((s) => paymentOutcome(200, s) === "retry") &&
    paymentOutcome(202, "pending") === "retry" && paymentOutcome(202, undefined) === "retry");
  check("errors without a payment status are unknown, not 'not charged'",
    [[400, undefined], [401, undefined], [404, undefined], [422, "failed-ish"], [500, undefined], [503, undefined]]
      .every(([code, s]) => paymentOutcome(code as number, s) === "unknown"));
}

// Paying once for Team doesn't stop a Pro subscription: the card and the Billing page say so.
{
  const v = viewer(sub("pro", "active"));
  check("Pro subscriber: Team pay once says Pro still renews",
    cardOffer("team", v.plan, v.billing).payOnceNote === "Your Pro subscription still renews on 17 Nov 2026. Cancel it under Manage subscription.",
    cardOffer("team", v.plan, v.billing).payOnceNote);
  const late = viewer(sub("pro", "attention", "2026-10-16T08:00:00Z"));
  check("past-due Pro: Team pay once says Pro still renews, without a past date",
    cardOffer("team", late.plan, late.billing).payOnceNote === "Your Pro subscription still renews. Cancel it under Manage subscription.",
    cardOffer("team", late.plan, late.billing).payOnceNote);
  const ending = viewer(sub("pro", "non-renewing"));
  check("non-renewing Pro: no renewal note on Team pay once", cardOffer("team", ending.plan, ending.billing).payOnceNote === null);

  const both = viewer(row({
    subscription_plan: "pro", subscription_status: "active", current_period_end: "2026-11-07T08:00:00Z",
    prepaid_plan: "team", paid_until: "2026-11-18T08:00:00Z",
  }));
  check("Pro subscriber who paid once for Team: Billing shows Paid until and the Pro renewal",
    JSON.stringify(planStatus(both.billing)) === JSON.stringify(["Paid until 18 Nov 2026", "Pro subscription renews 7 Nov 2026"]),
    planStatus(both.billing));
  const cancelled = viewer(row({
    subscription_plan: "pro", subscription_status: "non-renewing", current_period_end: "2026-11-07T08:00:00Z",
    prepaid_plan: "team", paid_until: "2026-11-18T08:00:00Z",
  }));
  check("cancelled Pro under prepaid Team: no renewal line",
    JSON.stringify(planStatus(cancelled.billing)) === JSON.stringify(["Paid until 18 Nov 2026"]), planStatus(cancelled.billing));
  check("Pro subscriber: Billing shows one Renews line",
    JSON.stringify(planStatus(v.billing)) === JSON.stringify(["Renews 17 Nov 2026"]), planStatus(v.billing));
  const ended = viewer(row({ prepaid_plan: "pro", paid_until: "2026-10-01T08:00:00Z" }));
  check("ended prepaid Pro: Billing says when it ended",
    JSON.stringify(planStatus(ended.billing)) === JSON.stringify(["Pro ended 1 Oct 2026"]), planStatus(ended.billing));
}

// Payment return: a slow payment keeps being checked until it clears.
{
  const answers = (n: number, last: PaymentOutcome) => {
    let calls = 0;
    return { verify: async () => (++calls > n ? last : "retry") as PaymentOutcome, calls: () => calls };
  };
  const waits: number[] = [];
  let pending = 0;
  const slow = answers(25, "success");
  const outcome = await waitForPayment(slow.verify, {
    sleep: async (ms) => { waits.push(ms); },
    stopped: () => false,
    onPending: () => { pending++; },
  });
  check("still processing past the fast tries: keeps checking until success",
    outcome === "success" && slow.calls() === 26, { outcome, calls: slow.calls() });
  check("says 'still processing' once, after 8 tries", pending === 1);
  check("checks every 2 s, then 15 s, 30 s, then once a minute",
    waits.slice(0, 7).every((ms) => ms === 2000) && waits[7] === 15000 && waits[8] === 30000 &&
      waits.slice(9).every((ms) => ms === 60000) && verifyDelay(100) === 60000, waits);

  // React's development double run: the first run is stopped, the second still finishes.
  let firstStopped = false;
  const first = waitForPayment(async () => { firstStopped = true; return "retry"; }, {
    sleep: async () => {}, stopped: () => firstStopped, onPending: () => { pending++; },
  });
  const second = waitForPayment(answers(2, "failed").verify, {
    sleep: async () => {}, stopped: () => false, onPending: () => {},
  });
  check("a stopped run ends quietly", (await first) === null);
  check("another run isn't stopped with it", (await second) === "failed");
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
