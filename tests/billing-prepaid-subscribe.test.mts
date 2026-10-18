// Prepaid Pro, then a monthly Team subscription: the paid Pro time ran out
// unused beside Team, and the Billing page stopped mentioning it. Now a
// subscription waits for a prepaid term to end (paying once carries the time
// over instead), and a prepaid term running beside a subscription is listed.
import { resolveAccess, summarize, type BillingRow } from "../lib/billing.ts";
import { cardOffer, payOnceBlock, planStatus, subscribeBlock } from "../lib/billing-ui.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const now = new Date("2026-10-18T08:00:00Z");
function row(extra: Partial<BillingRow> = {}): BillingRow {
  return {
    id: "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d", email: "u@x.co", subscription_plan: null, subscription_status: null,
    current_period_end: null, prepaid_plan: null, paid_until: null, paystack_customer_code: null,
    paystack_subscription_code: null, paystack_email_token: null, ...extra,
  };
}
function viewer(own: BillingRow) {
  const access = resolveAccess({ own, emailVerified: true, teamOwners: [] }, now);
  return { plan: access.plan, billing: summarize(own, access, now) };
}

// Prepaid Pro for another 300 days.
{
  const v = viewer(row({ prepaid_plan: "pro", paid_until: "2027-08-14T08:00:00Z" }));
  const team = cardOffer("team", v.plan, v.billing);
  check("prepaid Pro: no monthly 'Upgrade to Team' button", team.main === "blocked", team);
  check("prepaid Pro: says why, plainly",
    team.text === "Your Pro plan is paid until 14 Aug 2027. Subscribe to Team after that.", team.text);
  check("prepaid Pro: Team can still be paid once, and the Pro time carries over",
    team.payOnce && team.payOnceNote === "Your Pro time left carries over." && payOnceBlock("team", v.billing) === null, team);
  check("prepaid Pro: checkout refuses a Team subscription", subscribeBlock("team", v.billing) !== null);
  check("prepaid Pro: and a Pro subscription", subscribeBlock("pro", v.billing) !== null);
}

// Prepaid Team: nothing monthly either.
{
  const v = viewer(row({ prepaid_plan: "team", paid_until: "2026-12-01T08:00:00Z" }));
  check("prepaid Team: checkout refuses a Pro subscription",
    subscribeBlock("pro", v.billing) === "Your Team plan is paid until 1 Dec 2026. Subscribe to Pro after that.",
    subscribeBlock("pro", v.billing));
  check("prepaid Team: and a Team subscription", subscribeBlock("team", v.billing) !== null);
}

// An ended prepaid term doesn't block anything.
{
  const v = viewer(row({ prepaid_plan: "pro", paid_until: "2026-10-01T08:00:00Z" }));
  check("ended prepaid Pro: Team can be subscribed to",
    subscribeBlock("team", v.billing) === null && cardOffer("team", v.plan, v.billing).main === "subscribe");
}

// Accounts already in this state: Team subscription with prepaid Pro left.
{
  const v = viewer(row({
    subscription_plan: "team", subscription_status: "active", current_period_end: "2026-11-18T08:00:00Z",
    paystack_subscription_code: "SUB_1", prepaid_plan: "pro", paid_until: "2027-08-14T08:00:00Z",
  }));
  check("Team subscription over prepaid Pro: Billing lists both",
    JSON.stringify(planStatus(v.billing)) === JSON.stringify(["Renews 18 Nov 2026", "Pro paid until 14 Aug 2027"]),
    planStatus(v.billing));
  const plain = viewer(row({
    subscription_plan: "team", subscription_status: "active", current_period_end: "2026-11-18T08:00:00Z",
    paystack_subscription_code: "SUB_1", prepaid_plan: "pro", paid_until: "2026-10-01T08:00:00Z",
  }));
  check("an ended prepaid term isn't listed beside a subscription",
    JSON.stringify(planStatus(plain.billing)) === JSON.stringify(["Renews 18 Nov 2026"]), planStatus(plain.billing));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll prepaid and subscription checks passed.");
