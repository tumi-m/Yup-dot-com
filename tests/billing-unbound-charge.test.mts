// A Paystack-signed event only says Paystack took a payment. Whoever starts a
// payment chooses its email and metadata, and Paystack keeps one customer per
// email, so a charge or subscription this server never started could rewrite
// someone else's billing row: a Team term or subscription forced down to Pro
// (their members dropped to Free), their subscription code swapped for
// another (their own cancel then ignored as stale), or their customer code
// swapped (their renewals then "unknown customer"). Only a charge carrying
// our checkout's signature now starts or changes a plan; anything else can
// only renew the subscription a row already holds, and a subscription code
// is only taken up by the subscription our checkout started.
import { readFileSync } from "node:fs";
import {
  checkoutMetadata, handlePaystackEvent, ownPlan, resolveAccess,
  type BillingPatch, type BillingRow, type BillingStore, type EventDeps,
} from "../lib/billing.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const SECRET = "sk_test_abc123";
const V = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d"; // the victim
const A = "0f8e7d6c-5b4a-4321-8fed-cba987654321"; // someone paying with the victim's email or customer
const clock = new Date("2026-10-04T08:00:00Z");
const YEAR_ON = "2027-10-04T08:00:00.000Z";
const CODES: Record<string, "pro" | "team"> = { PLN_pro: "pro", PLN_team: "team" };

function row(id: string, email: string, extra: Partial<BillingRow> = {}): BillingRow {
  return {
    id, email, subscription_plan: null, subscription_status: null, current_period_end: null,
    prepaid_plan: null, paid_until: null, paystack_customer_code: null,
    paystack_subscription_code: null, paystack_email_token: null, ...extra,
  };
}
// Customer and subscription codes are unique, as in supabase/schema.sql.
function setup(rows: BillingRow[]) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const events = new Set<string>();
  const store: BillingStore = {
    async claimEvent(k) { if (events.has(k)) return false; events.add(k); return true; },
    async releaseEvent(k) { events.delete(k); },
    async getRow(id) { const r = db.get(id); return r ? { ...r } : null; },
    async findUserId(by: { subscriptionCode?: string; customerCode?: string; email?: string }) {
      for (const r of db.values()) {
        if (by.subscriptionCode ? r.paystack_subscription_code === by.subscriptionCode
          : by.customerCode ? r.paystack_customer_code === by.customerCode
          : r.email === by.email?.toLowerCase()) return r.id;
      }
      return null;
    },
    async updateRow(id, p: BillingPatch) {
      const { plan: _p, ...rest } = p;
      const next = { ...db.get(id)!, ...rest };
      for (const c of ["paystack_customer_code", "paystack_subscription_code"] as const) {
        if (next[c] && [...db.values()].some((o) => o.id !== id && o[c] === next[c])) throw new Error(`duplicate key ${c}`);
      }
      db.set(id, next);
    },
  };
  const deps: EventDeps = { store, planForCode: (c) => (c ? CODES[c] ?? null : null), checkoutSecret: SECRET, now: () => clock };
  // A throw is a 500 to Paystack, which then delivers it again and again.
  const deliver = async (event: string, data: unknown) => {
    const raw = JSON.stringify({ event, data });
    try {
      return await handlePaystackEvent(JSON.parse(raw), raw, deps);
    } catch (err) {
      return { status: "threw", reason: String(err) } as const;
    }
  };
  return { db, events, deliver, get: (id: string) => db.get(id)! };
}
const member = (owner: BillingRow) =>
  resolveAccess({ own: row("11111111-2222-4333-8444-555555555555", "m@x.co"), emailVerified: true, teamOwners: [owner] }, clock).plan;

const teamTerm = { prepaid_plan: "team" as const, paid_until: YEAR_ON, paystack_customer_code: "CUS_v" };
const teamSub = {
  subscription_plan: "team" as const, subscription_status: "active" as const, current_period_end: "2026-10-20T08:00:00.000Z",
  paystack_customer_code: "CUS_v", paystack_subscription_code: "SUB_v", paystack_email_token: "tok_v",
};

// (a) A once-off payment this server never started, charged to the victim's customer.
{
  const s = setup([row(V, "v@x.co", teamTerm)]);
  const r = await s.deliver("charge.success", {
    status: "success", reference: "T_x", amount: 4900, currency: "ZAR",
    customer: { customer_code: "CUS_v" }, metadata: { mode: "once", plan: "pro", months: 1 },
  });
  check("foreign once-off charge: ignored, the Team term stays", r.status === "ignored" &&
    s.get(V).prepaid_plan === "team" && s.get(V).paid_until === YEAR_ON && member(s.get(V)) === "team", { r, row: s.get(V) });

  const named = await s.deliver("charge.success", {
    status: "success", reference: "T_y", amount: 4900, currency: "ZAR",
    customer: { customer_code: "CUS_att" }, metadata: { user_id: V, mode: "once", plan: "pro", months: 1, sig: "ab".repeat(32) },
  });
  check("naming the victim with a made-up signature: ignored", named.status === "ignored" && s.get(V).prepaid_plan === "team", named);

  // A real signature from one's own checkout doesn't carry over to another account or reference.
  const own = checkoutMetadata("pw_attacker", { user_id: A, plan: "pro", mode: "once", months: 1 }, SECRET);
  const moved = await s.deliver("charge.success", {
    status: "success", reference: "pw_attacker", amount: 4900, currency: "ZAR",
    customer: { customer_code: "CUS_v" }, metadata: { ...own, user_id: V },
  });
  const replayed = await s.deliver("charge.success", {
    status: "success", reference: "T_other", amount: 4900, currency: "ZAR", customer: { customer_code: "CUS_v" }, metadata: own,
  });
  check("our signature for another account or reference: ignored", moved.status === "ignored" && replayed.status === "ignored" &&
    s.get(V).prepaid_plan === "team", { moved, replayed });
  const wrongSecret = checkoutMetadata("T_z", { user_id: V, plan: "pro", mode: "once", months: 1 }, "sk_test_other");
  const forged = await s.deliver("charge.success", {
    status: "success", reference: "T_z", amount: 4900, currency: "ZAR", customer: { customer_code: "CUS_v" }, metadata: wrongSecret,
  });
  check("signed with another key: ignored", forged.status === "ignored" && s.get(V).prepaid_plan === "team", forged);
}

// (b) A subscription someone else started with the victim's email (Paystack reuses CUS_v).
{
  const s = setup([row(V, "v@x.co", teamSub)]);
  for (const plan of ["PLN_pro", "PLN_team"]) {
    const r = await s.deliver("subscription.create", {
      subscription_code: `SUB_att_${plan}`, status: "active", email_token: "tok_att", next_payment_date: "2026-11-04T08:00:00.000Z",
      plan: { plan_code: plan }, customer: { customer_code: "CUS_v", email: "v@x.co" },
    });
    check(`foreign subscription.create (${plan}): ignored, the victim's subscription stays`, r.status === "ignored" &&
      s.get(V).paystack_subscription_code === "SUB_v" && s.get(V).subscription_plan === "team" &&
      s.get(V).paystack_email_token === "tok_v" && ownPlan(s.get(V), clock) === "team", { r, row: s.get(V) });
  }
  const charge = await s.deliver("charge.success", {
    status: "success", reference: "T_att1", amount: 4900, currency: "ZAR", plan: { plan_code: "PLN_pro" },
    customer: { customer_code: "CUS_v" }, metadata: { user_id: V, plan: "pro", mode: "subscription" },
  });
  check("its first charge (no signature): ignored, still Team", charge.status === "ignored" &&
    s.get(V).subscription_plan === "team" && member(s.get(V)) === "team", { charge, row: s.get(V) });
  for (const [event, data] of [
    ["subscription.not_renew", { subscription_code: "SUB_att", status: "non-renewing", customer: { customer_code: "CUS_v" } }],
    ["invoice.payment_failed", { subscription: { subscription_code: "SUB_att", status: "attention" }, customer: { customer_code: "CUS_v" } }],
  ] as const) {
    const r = await s.deliver(event, data);
    check(`its ${event}: ignored`, r.status === "ignored" && s.get(V).subscription_status === "active", r);
  }
  const cancel = await s.deliver("subscription.disable", { subscription_code: "SUB_v", status: "cancelled", customer: { customer_code: "CUS_v" } });
  check("the victim's own cancel still applies", cancel.status === "applied" && s.get(V).subscription_status === "cancelled", cancel);
}

// Found only by email: never matched to an account.
{
  const s = setup([row(V, "v@x.co", teamSub)]);
  const r = await s.deliver("subscription.create", {
    subscription_code: "SUB_att2", status: "active", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_other", email: "V@x.co" },
  });
  check("email-only subscription.create: not applied to anyone", r.status !== "applied" &&
    s.get(V).paystack_customer_code === "CUS_v" && s.get(V).paystack_subscription_code === "SUB_v", { r, row: s.get(V) });
}

// Without a subscription, a foreign subscription's events don't give the row one.
{
  const s = setup([row(V, "v@x.co", teamTerm)]);
  const create = await s.deliver("subscription.create", {
    subscription_code: "SUB_att", status: "active", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" },
  });
  const failedPay = await s.deliver("invoice.payment_failed", {
    subscription: { subscription_code: "SUB_att", status: "attention" }, customer: { customer_code: "CUS_v" },
  });
  check("prepaid-only row: create waits, other events ignored, nothing written", create.status === "retry" &&
    failedPay.status === "ignored" && s.get(V).paystack_subscription_code === null && s.get(V).subscription_status === null &&
    s.events.size === 0, { create, failedPay, row: s.get(V) });
}

// (c) A charge naming the victim's account, for another customer.
{
  const s = setup([row(V, "v@x.co", { ...teamSub, subscription_plan: "pro" })]);
  const r = await s.deliver("charge.success", {
    status: "success", reference: "T_att", amount: 4900, currency: "ZAR", plan: { plan_code: "PLN_pro" },
    customer: { customer_code: "CUS_att" }, metadata: { user_id: V, plan: "pro", mode: "subscription" },
  });
  check("metadata naming the victim: ignored, customer code kept", r.status === "ignored" &&
    s.get(V).paystack_customer_code === "CUS_v", { r, row: s.get(V) });
  const renew = await s.deliver("charge.success", {
    status: "success", reference: "T_renew", amount: 4900, currency: "ZAR", paid_at: "2026-10-20T08:30:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" }, metadata: "",
  });
  check("the victim's renewal still applies", renew.status === "applied" && s.get(V).current_period_end === "2026-11-20T08:30:00.000Z", renew);
}

// A charge on the victim's customer for another plan, with no metadata, is no renewal of theirs.
{
  const s = setup([row(V, "v@x.co", teamSub)]);
  const r = await s.deliver("charge.success", {
    status: "success", reference: "T_pro", amount: 4900, currency: "ZAR", plan: { plan_code: "PLN_pro" },
    customer: { customer_code: "CUS_v" }, metadata: "",
  });
  check("metadata-less charge for another plan: ignored, still Team", r.status === "ignored" &&
    s.get(V).subscription_plan === "team" && s.events.size === 0, { r, row: s.get(V) });
}

// The victim changed their email; someone signed up with the old one and subscribed through
// our own checkout. Paystack gave them the victim's customer.
{
  const s = setup([row(V, "new@x.co", teamSub), row(A, "v@x.co")]);
  const first = await s.deliver("charge.success", {
    status: "success", reference: "pw_a1", amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" },
    metadata: checkoutMetadata("pw_a1", { user_id: A, plan: "pro", mode: "subscription" }, SECRET),
  });
  check("their own first charge applies to them, without taking the victim's customer", first.status === "applied" &&
    s.get(A).subscription_plan === "pro" && s.get(A).paystack_customer_code === null && s.get(V).paystack_customer_code === "CUS_v",
    { first, a: s.get(A) });
  const create = await s.deliver("subscription.create", {
    subscription_code: "SUB_att", status: "active", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v", email: "v@x.co" },
  });
  check("their subscription.create doesn't replace the victim's Team subscription", create.status === "ignored" &&
    s.get(V).paystack_subscription_code === "SUB_v" && s.get(V).subscription_plan === "team" && ownPlan(s.get(V), clock) === "team",
    { create, v: s.get(V) });
}

// Our own checkout still works: a once-off payment, and a subscription with its code and renewal.
{
  const s = setup([row(V, "v@x.co")]);
  const once = await s.deliver("charge.success", {
    status: "success", reference: "pw_o1", amount: 19900, currency: "ZAR", customer: { customer_code: "CUS_v" },
    metadata: JSON.stringify(checkoutMetadata("pw_o1", { user_id: V, plan: "team", mode: "once", months: 1 }, SECRET)),
  });
  check("signed once-off: applied", once.status === "applied" && s.get(V).prepaid_plan === "team" &&
    s.get(V).paystack_customer_code === "CUS_v", once);
  const wrongAmount = await s.deliver("charge.success", {
    status: "success", reference: "pw_o2", amount: 4900, currency: "ZAR", customer: { customer_code: "CUS_v" },
    metadata: checkoutMetadata("pw_o2", { user_id: V, plan: "team", mode: "once", months: 1 }, SECRET),
  });
  check("signed, but a Team month paid at the Pro price: ignored", wrongAmount.status === "ignored", wrongAmount);

  const t = setup([row(V, "v@x.co", { paystack_customer_code: "CUS_v" })]);
  const first = await t.deliver("charge.success", {
    status: "success", reference: "pw_s1", amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" },
    metadata: checkoutMetadata("pw_s1", { user_id: V, plan: "pro", mode: "subscription" }, SECRET),
  });
  const otherPlan = await t.deliver("subscription.create", {
    subscription_code: "SUB_x", status: "active", plan: { plan_code: "PLN_team" }, customer: { customer_code: "CUS_v" },
  });
  const create = await t.deliver("subscription.create", {
    subscription_code: "SUB_1", status: "active", email_token: "tok_1", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" },
  });
  const renew = await t.deliver("charge.success", {
    status: "success", reference: "T_r1", amount: 4900, currency: "ZAR", paid_at: "2026-11-04T08:30:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" }, metadata: "",
  });
  check("signed subscription: first charge, its create (not another plan's), renewal",
    first.status === "applied" && otherPlan.status === "ignored" && create.status === "applied" && renew.status === "applied" &&
      t.get(V).paystack_subscription_code === "SUB_1" && t.get(V).current_period_end === "2026-12-04T08:30:00.000Z",
    { first, otherPlan, create, renew, row: t.get(V) });
  const signedWrongPlan = await t.deliver("charge.success", {
    status: "success", reference: "pw_s2", amount: 19900, currency: "ZAR", plan: { plan_code: "PLN_team" },
    customer: { customer_code: "CUS_v" }, metadata: checkoutMetadata("pw_s2", { user_id: V, plan: "pro", mode: "subscription" }, SECRET),
  });
  check("signed for Pro, charged on the Team plan: ignored", signedWrongPlan.status === "ignored", signedWrongPlan);
}

// Between a signed first charge and its subscription.create, an event for another code (the
// account's own ended subscription, or someone else's on the same customer) doesn't take the
// row: it waits, and once the create has stored the real code it is stale.
for (const [label, start, other] of [
  ["the account's ended subscription", {
    subscription_plan: "pro", subscription_status: "non-renewing", current_period_end: "2026-10-01T08:00:00.000Z",
    paystack_customer_code: "CUS_v", paystack_subscription_code: "SUB_old", paystack_email_token: "tok_old",
  }, { subscription_code: "SUB_old", status: "complete", plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" } }],
  ["someone else's Team subscription", { paystack_customer_code: "CUS_v" },
    { subscription_code: "SUB_att", status: "cancelled", plan: { plan_code: "PLN_team" }, customer: { customer_code: "CUS_v" } }],
] as const) {
  const s = setup([row(V, "v@x.co", start)]);
  const first = await s.deliver("charge.success", {
    status: "success", reference: "pw_w1", amount: 4900, currency: "ZAR", paid_at: clock.toISOString(),
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" },
    metadata: checkoutMetadata("pw_w1", { user_id: V, plan: "pro", mode: "subscription" }, SECRET),
  });
  const early = await s.deliver("subscription.disable", other);
  check(`${label}: its disable in the window waits and writes nothing`, first.status === "applied" && early.status === "retry" &&
    s.get(V).paystack_subscription_code === null && s.get(V).subscription_status === "active", { early, row: s.get(V) });
  const create = await s.deliver("subscription.create", {
    subscription_code: "SUB_new", status: "active", email_token: "tok_new", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_v" },
  });
  const late = await s.deliver("subscription.disable", other);
  const cancel = await s.deliver("subscription.not_renew", { subscription_code: "SUB_new", status: "non-renewing", customer: { customer_code: "CUS_v" } });
  check(`${label}: the account's own create and cancel apply, the other code is stale`,
    create.status === "applied" && late.status === "ignored" && cancel.status === "applied" &&
      s.get(V).paystack_subscription_code === "SUB_new" && s.get(V).paystack_email_token === "tok_new" &&
      s.get(V).subscription_status === "non-renewing", { create, late, cancel, row: s.get(V) });
}

// The routes: checkout signs what it sells; the webhook and the return check it; "retry" isn't a 200.
{
  const checkout = readFileSync(new URL("../app/api/billing/checkout/route.ts", import.meta.url), "utf8");
  check("checkout sends signed metadata", /metadata: checkoutMetadata\(reference, sold, paystack\.secretKey\)/.test(checkout));
  const webhook = readFileSync(new URL("../app/api/billing/webhook/route.ts", import.meta.url), "utf8");
  check("webhook checks the signature with the secret key", /checkoutSecret: secret/.test(webhook));
  check("webhook answers 503 to an event that can't apply yet", /result\.status === "retry"[\s\S]{0,160}503/.test(webhook));
  const verify = readFileSync(new URL("../app/api/billing/verify/route.ts", import.meta.url), "utf8");
  check("return from checkout checks it too", /checkoutSecret: paystack\.secretKey/.test(verify));
  const store = readFileSync(new URL("../lib/billing-store.ts", import.meta.url), "utf8");
  check("the store finds no customer by email", !/"email", by\.email/.test(store));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll unbound charge checks passed.");
