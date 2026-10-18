// A member with prepaid Pro time who was given a Team seat saw only "Seat on
// …'s team": the Pro time kept running out with no sign of it on Billing.
// Paid time is now listed under a seat too.
import { resolveAccess, summarize, type BillingRow } from "../lib/billing.ts";
import { planStatus } from "../lib/billing-ui.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const now = new Date("2026-10-18T08:00:00Z");
const base: BillingRow = {
  id: "m", email: "m@x.co", subscription_plan: null, subscription_status: null, current_period_end: null,
  prepaid_plan: null, paid_until: null, paystack_customer_code: null, paystack_subscription_code: null,
  paystack_email_token: null,
};
const owner: BillingRow = {
  ...base, id: "o", email: "o@x.co", subscription_plan: "team", subscription_status: "active",
  current_period_end: "2026-11-07T08:00:00Z", paystack_subscription_code: "SUB_T",
};
const lines = (member: BillingRow, ownerEmail: string | null = "o@x.co") => {
  const access = resolveAccess({ own: member, emailVerified: true, teamOwners: [owner] }, now);
  return { source: access.source, lines: planStatus(summarize(member, access, now, ownerEmail)) };
};

{
  const v = lines({ ...base, prepaid_plan: "pro", paid_until: "2027-09-13T08:00:00Z" });
  check("seat with prepaid Pro: the seat and the Pro time are both listed",
    v.source === "team" && JSON.stringify(v.lines) === JSON.stringify(["Seat on o@x.co's team", "Pro paid until 13 Sep 2027"]), v);
  const anon = lines({ ...base, prepaid_plan: "pro", paid_until: "2027-09-13T08:00:00Z" }, null);
  check("without the owner's email too", JSON.stringify(anon.lines) === JSON.stringify(["Team seat", "Pro paid until 13 Sep 2027"]), anon);
}
{
  const v = lines({ ...base, prepaid_plan: "pro", paid_until: "2026-10-01T08:00:00Z" });
  check("seat with ended prepaid Pro: just the seat", JSON.stringify(v.lines) === JSON.stringify(["Seat on o@x.co's team"]), v);
  const plain = lines(base);
  check("seat only: just the seat", JSON.stringify(plain.lines) === JSON.stringify(["Seat on o@x.co's team"]), plain);
}
{
  const v = lines({
    ...base, prepaid_plan: "pro", paid_until: "2027-09-13T08:00:00Z",
    subscription_plan: "pro", subscription_status: "non-renewing", current_period_end: "2026-11-01T08:00:00Z",
  });
  check("seat with prepaid Pro and an ending Pro subscription: seat and paid time",
    JSON.stringify(v.lines) === JSON.stringify(["Seat on o@x.co's team", "Pro paid until 13 Sep 2027"]), v);
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Team seat prepaid checks passed.");
