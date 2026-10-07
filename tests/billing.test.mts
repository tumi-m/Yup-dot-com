/**
 * Billing: Paystack webhook signatures, event handling against an in-memory
 * store (prepaid terms, the subscription lifecycle, idempotency), plan
 * resolution with Team seats, prices, and the Paystack client with a fake
 * network.
 */
import {
  addMonths, applyCharge, checkNewMember, handlePaystackEvent, hasLiveSubscription, ownPlan,
  resolveAccess, signPaystackBody, summarize, verifyPaystackSignature, RENEWAL_GRACE_MS,
  type BillingPatch, type BillingRow, type BillingStore, type EventDeps,
} from "../lib/billing.ts";
import { formatPrice, prepaidPrice, toSubunit, PLANS, TEAM_SEATS, formatBillingDate } from "../lib/plans.ts";
import {
  initializeTransaction, subscriptionManageLink, verifyTransaction, planForCode, isOurReference,
  newReference, PaystackError, ONCE_OFF_CHANNELS, SUBSCRIPTION_CHANNELS,
} from "../lib/paystack.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const SECRET = "sk_test_abc123";
const DAY = 24 * 60 * 60 * 1000;
const USER = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d";
const OWNER = "0f8e7d6c-5b4a-4321-8fed-cba987654321";
const CODES = { pro: "PLN_pro", team: "PLN_team" };

// ---------- in-memory store ----------
function row(id: string, email: string, extra: Partial<BillingRow> = {}): BillingRow {
  return {
    id, email, subscription_plan: null, subscription_status: null, current_period_end: null,
    prepaid_plan: null, paid_until: null, paystack_customer_code: null,
    paystack_subscription_code: null, paystack_email_token: null, ...extra,
  };
}
function fakeStore(rows: BillingRow[]) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const events = new Set<string>();
  let failNextUpdate = false;
  const store: BillingStore & { db: typeof db; events: typeof events; failNext(): void } = {
    db, events,
    failNext() { failNextUpdate = true; },
    async claimEvent(key) { if (events.has(key)) return false; events.add(key); return true; },
    async releaseEvent(key) { events.delete(key); },
    async getRow(id) { const r = db.get(id); return r ? { ...r } : null; },
    async findUserId(by) {
      for (const r of db.values()) {
        if (by.subscriptionCode && r.paystack_subscription_code === by.subscriptionCode) return r.id;
        if (!by.subscriptionCode && by.customerCode && r.paystack_customer_code === by.customerCode) return r.id;
        if (!by.subscriptionCode && !by.customerCode && by.email && r.email === by.email) return r.id;
      }
      return null;
    },
    async updateRow(id, patch: BillingPatch) {
      if (failNextUpdate) { failNextUpdate = false; throw new Error("db down"); }
      const r = db.get(id)!;
      const { plan: _ignored, ...rest } = patch;
      db.set(id, { ...r, ...rest });
    },
  };
  return store;
}

let clock = new Date("2026-10-04T08:00:00Z");
const deps = (store: BillingStore): EventDeps => ({
  store, planForCode: (c) => planForCode(c, CODES), now: () => clock,
});
const deliver = (store: BillingStore, event: string, data: unknown) => {
  const raw = JSON.stringify({ event, data });
  return handlePaystackEvent(JSON.parse(raw), raw, deps(store));
};

// ---------- signatures ----------
{
  const body = JSON.stringify({ event: "charge.success", data: { reference: "pw_1", amount: 4900 } });
  const sig = signPaystackBody(body, SECRET);
  check("signature: valid", verifyPaystackSignature(body, sig, SECRET));
  check("signature: valid on raw bytes", verifyPaystackSignature(Buffer.from(body), sig, SECRET));
  check("signature: uppercase hex accepted", verifyPaystackSignature(body, sig.toUpperCase(), SECRET));
  check("signature: tampered body rejected", !verifyPaystackSignature(body.replace("4900", "1"), sig, SECRET));
  check("signature: wrong key rejected", !verifyPaystackSignature(body, signPaystackBody(body, "sk_test_other"), SECRET));
  check("signature: missing header rejected", !verifyPaystackSignature(body, null, SECRET) && !verifyPaystackSignature(body, "", SECRET));
  check("signature: missing secret rejected", !verifyPaystackSignature(body, sig, undefined));
  check("signature: truncated / non-hex rejected",
    !verifyPaystackSignature(body, sig.slice(0, 64), SECRET) && !verifyPaystackSignature(body, "z".repeat(128), SECRET));
  check("signature: sha256 instead of sha512 rejected",
    !verifyPaystackSignature(body, (await import("node:crypto")).createHmac("sha256", SECRET).update(body).digest("hex"), SECRET));
}

// ---------- once-off (prepaid) ----------
const onceTx = (ref: string, plan: string, months: number, amount: number) => ({
  status: "success", reference: ref, amount, currency: "ZAR", paid_at: clock.toISOString(),
  customer: { customer_code: "CUS_user", email: "u@x.co" },
  metadata: { user_id: USER, plan, mode: "once", months },
});
{
  clock = new Date("2026-10-04T08:00:00Z");
  const store = fakeStore([row(USER, "u@x.co")]);
  const r1 = await deliver(store, "charge.success", onceTx("pw_a", "pro", 1, 4900));
  const u = store.db.get(USER)!;
  check("once-off charge.success grants Pro for a month", r1.status === "applied" && u.prepaid_plan === "pro" &&
    u.paid_until === "2026-11-04T08:00:00.000Z", JSON.stringify(u));
  check("once-off stores customer code", u.paystack_customer_code === "CUS_user");
  check("prepaid Pro resolves to pro", ownPlan(u, clock) === "pro");

  const dup = await deliver(store, "charge.success", onceTx("pw_a", "pro", 1, 4900));
  check("duplicate delivery is a no-op", dup.status === "duplicate" && store.db.get(USER)!.paid_until === "2026-11-04T08:00:00.000Z");
  const viaVerify = await applyCharge(onceTx("pw_a", "pro", 1, 4900), deps(store));
  check("verify after webhook (same reference) is a no-op", viaVerify.status === "duplicate");

  const r2 = await deliver(store, "charge.success", onceTx("pw_b", "pro", 12, 49000));
  check("12 months costs 10x and extends from the current end",
    r2.status === "applied" && store.db.get(USER)!.paid_until === "2027-11-04T08:00:00.000Z", store.db.get(USER)!.paid_until!);

  const bad = await deliver(store, "charge.success", onceTx("pw_c", "team", 12, 23880));
  check("amount that doesn't match the price is ignored", bad.status === "ignored" && store.db.get(USER)!.prepaid_plan === "pro");
  const badMeta = await deliver(store, "charge.success", onceTx("pw_d", "pro", 6, 29400));
  check("unsupported term ignored", badMeta.status === "ignored");
  const failed = await deliver(store, "charge.success", { ...onceTx("pw_e", "pro", 1, 4900), status: "failed" });
  check("unsuccessful charge ignored", failed.status === "ignored");
  const usd = await deliver(store, "charge.success", { ...onceTx("pw_f", "pro", 1, 4900), currency: "USD" });
  check("non-ZAR charge ignored", usd.status === "ignored");
  const strMeta = await applyCharge({ ...onceTx("pw_g", "team", 1, 19900), metadata: JSON.stringify(onceTx("", "team", 1, 0).metadata) }, deps(store));
  check("metadata as a JSON string is understood; a different plan starts now",
    strMeta.status === "applied" && store.db.get(USER)!.prepaid_plan === "team" && store.db.get(USER)!.paid_until === "2026-11-04T08:00:00.000Z");

  clock = new Date("2026-11-04T08:00:01Z");
  check("prepaid expires at read time (no cron)", ownPlan(store.db.get(USER)!, clock) === "free");
  clock = new Date("2026-11-04T07:59:59Z");
  check("…and is active up to the second", ownPlan(store.db.get(USER)!, clock) === "team");
}

// Failure mid-way releases the claim so Paystack's retry is processed.
{
  clock = new Date("2026-10-04T08:00:00Z");
  const store = fakeStore([row(USER, "u@x.co")]);
  store.failNext();
  let threw = false;
  try { await deliver(store, "charge.success", onceTx("pw_r", "pro", 1, 4900)); } catch { threw = true; }
  check("db failure throws (webhook answers 500) and releases the claim", threw && !store.events.has("charge:pw_r"));
  const retry = await deliver(store, "charge.success", onceTx("pw_r", "pro", 1, 4900));
  check("retry after failure applies", retry.status === "applied" && store.db.get(USER)!.prepaid_plan === "pro");
}

// ---------- subscription lifecycle ----------
{
  clock = new Date("2026-10-04T08:00:00Z");
  const store = fakeStore([row(USER, "u@x.co")]);
  const firstCharge = {
    status: "success", reference: "pw_s1", amount: 4900, currency: "ZAR", paid_at: "2026-10-04T08:00:00.000Z",
    customer: { customer_code: "CUS_u", email: "u@x.co" }, plan: { plan_code: "PLN_pro", name: "Pro" },
    metadata: { user_id: USER, plan: "pro", mode: "subscription" },
  };
  const a = await deliver(store, "charge.success", firstCharge);
  let u = store.db.get(USER)!;
  check("first subscription charge activates Pro", a.status === "applied" && u.subscription_plan === "pro" &&
    u.subscription_status === "active" && u.current_period_end === "2026-11-04T08:00:00.000Z" && ownPlan(u, clock) === "pro");
  check("live subscription blocks a second subscription checkout", hasLiveSubscription(u, clock));

  const create = await deliver(store, "subscription.create", {
    subscription_code: "SUB_1", email_token: "tok_1", status: "active", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_pro" }, customer: { customer_code: "CUS_u", email: "u@x.co" },
  });
  u = store.db.get(USER)!;
  check("subscription.create stores code, email token, next payment date",
    create.status === "applied" && u.paystack_subscription_code === "SUB_1" && u.paystack_email_token === "tok_1");
  check("summary offers Manage", summarize(u, resolveAccess({ own: u, emailVerified: true, teamOwners: [] }, clock), clock).subscription?.manageable === true);

  // Renewal: Paystack charges the card, no metadata; matched by customer code.
  clock = new Date("2026-11-04T09:00:00Z");
  const renew = await deliver(store, "charge.success", {
    status: "success", reference: "T_renew1", amount: 4900, currency: "ZAR", paid_at: "2026-11-04T08:30:00.000Z",
    customer: { customer_code: "CUS_u" }, plan: { plan_code: "PLN_pro" }, metadata: "",
  });
  u = store.db.get(USER)!;
  check("renewal charge extends the period", renew.status === "applied" && u.current_period_end === "2026-12-04T08:30:00.000Z", u.current_period_end!);

  // Payment fails at the next renewal.
  clock = new Date("2026-12-04T10:00:00Z");
  const failed = await deliver(store, "invoice.payment_failed", {
    subscription: { subscription_code: "SUB_1", status: "attention", next_payment_date: "2026-12-04T08:30:00.000Z" },
    customer: { customer_code: "CUS_u" },
  });
  u = store.db.get(USER)!;
  const s = summarize(u, resolveAccess({ own: u, emailVerified: true, teamOwners: [] }, clock), clock);
  check("invoice.payment_failed flags past due, access kept in grace", failed.status === "applied" &&
    u.subscription_status === "attention" && s.subscription?.pastDue === true && s.plan === "pro");
  check("past due beyond the grace window drops to free",
    ownPlan(u, new Date(new Date("2026-12-04T08:30:00Z").getTime() + RENEWAL_GRACE_MS + 1000)) === "free");

  const paid = await deliver(store, "invoice.update", {
    paid: true, status: "success",
    subscription: { subscription_code: "SUB_1", status: "active", next_payment_date: "2027-01-04T08:30:00.000Z" },
    customer: { customer_code: "CUS_u" },
  });
  u = store.db.get(USER)!;
  check("invoice.update (paid) clears past due and moves the period", paid.status === "applied" &&
    u.subscription_status === "active" && u.current_period_end === "2027-01-04T08:30:00.000Z");

  const notRenew = await deliver(store, "subscription.not_renew", {
    subscription_code: "SUB_1", status: "non-renewing", next_payment_date: null, customer: { customer_code: "CUS_u" },
  });
  u = store.db.get(USER)!;
  check("subscription.not_renew: cancels at period end, still Pro now",
    notRenew.status === "applied" && u.subscription_status === "non-renewing" && ownPlan(u, clock) === "pro");
  check("non-renewing has no grace after the end",
    ownPlan(u, new Date("2027-01-04T08:30:01Z")) === "free");
  check("non-renewing shows 'Ends' (renews=false)",
    summarize(u, resolveAccess({ own: u, emailVerified: true, teamOwners: [] }, clock), clock).subscription?.renews === false);

  const disable = await deliver(store, "subscription.disable", {
    subscription_code: "SUB_1", status: "complete", customer: { customer_code: "CUS_u" },
  });
  u = store.db.get(USER)!;
  check("subscription.disable keeps access until the period ends",
    disable.status === "applied" && u.subscription_status === "complete" && ownPlan(u, clock) === "pro");
  check("…then downgrades to free", ownPlan(u, new Date("2027-01-05T00:00:00Z")) === "free");
  check("ended subscription allows a new checkout", !hasLiveSubscription(u, new Date("2027-01-05T00:00:00Z")));

  const again = await deliver(store, "subscription.disable", {
    subscription_code: "SUB_1", status: "complete", customer: { customer_code: "CUS_u" },
  });
  check("duplicate subscription event is a no-op", again.status === "duplicate");

  const stale = await deliver(store, "subscription.disable", {
    subscription_code: "SUB_OLD", status: "cancelled", customer: { customer_code: "CUS_u" },
  });
  check("event for another (old) subscription code is ignored", stale.status === "ignored" && store.db.get(USER)!.subscription_status === "complete");

  for (const ev of ["transfer.success", "subscription.expiring_cards", "", "paymentrequest.success"]) {
    const r = await deliver(store, ev, { subscription_code: "SUB_1" });
    check(`unknown event '${ev}' ignored`, r.status === "ignored");
  }
  const unknownPlan = await deliver(store, "charge.success", { ...firstCharge, reference: "pw_x", plan: { plan_code: "PLN_someone_else" } });
  check("charge for a plan we don't sell is ignored", unknownPlan.status === "ignored");
  const stranger = await deliver(store, "charge.success", { ...firstCharge, reference: "pw_y", metadata: {}, customer: { customer_code: "CUS_nobody" } });
  check("charge from an unknown customer is ignored", stranger.status === "ignored");
}

// subscription.create can beat charge.success: matched by email.
{
  clock = new Date("2026-10-04T08:00:00Z");
  const store = fakeStore([row(USER, "u@x.co")]);
  const r = await deliver(store, "subscription.create", {
    subscription_code: "SUB_9", email_token: "t9", status: "active", next_payment_date: "2026-11-04T08:00:00.000Z",
    plan: { plan_code: "PLN_team" }, customer: { customer_code: "CUS_9", email: "U@X.co" },
  });
  const u = store.db.get(USER)!;
  check("subscription.create before charge.success matches by email", r.status === "applied" &&
    u.subscription_plan === "team" && u.paystack_customer_code === "CUS_9" && ownPlan(u, clock) === "team");
}

// ---------- plan resolution with seats ----------
{
  const now = new Date("2026-10-04T08:00:00Z");
  const teamOwner = row(OWNER, "boss@x.co", { subscription_plan: "team", subscription_status: "active", current_period_end: "2026-10-20T00:00:00Z" });
  const member = row(USER, "m@x.co");
  let a = resolveAccess({ own: member, emailVerified: true, teamOwners: [teamOwner] }, now);
  check("member of an active Team resolves to team", a.plan === "team" && a.source === "team" && a.teamOwnerId === OWNER);
  a = resolveAccess({ own: member, emailVerified: false, teamOwners: [teamOwner] }, now);
  check("unverified email gets no seat", a.plan === "free");
  const lapsed = { ...teamOwner, current_period_end: new Date(now.getTime() - RENEWAL_GRACE_MS - DAY).toISOString() };
  a = resolveAccess({ own: member, emailVerified: true, teamOwners: [lapsed] }, now);
  check("owner lapsed → members drop to free", a.plan === "free");
  const proOwner = { ...teamOwner, subscription_plan: "pro" as const };
  check("owner on Pro (not Team) grants no seats", resolveAccess({ own: member, emailVerified: true, teamOwners: [proOwner] }, now).plan === "free");
  const prepaidTeam = row(OWNER, "boss@x.co", { prepaid_plan: "team", paid_until: "2026-12-01T00:00:00Z" });
  check("prepaid Team owner grants seats", resolveAccess({ own: member, emailVerified: true, teamOwners: [prepaidTeam] }, now).plan === "team");
  const proMember = row(USER, "m@x.co", { prepaid_plan: "pro", paid_until: "2026-12-01T00:00:00Z" });
  check("own Pro + Team seat → team", resolveAccess({ own: proMember, emailVerified: true, teamOwners: [teamOwner] }, now).plan === "team");
  check("own Pro without seat → pro (prepaid)", (() => { const x = resolveAccess({ own: proMember, emailVerified: true, teamOwners: [lapsed] }, now); return x.plan === "pro" && x.source === "prepaid"; })());
  check("owner resolves to team via own subscription", resolveAccess({ own: teamOwner, emailVerified: true, teamOwners: [] }, now).source === "subscription");
  check("no profile → free", resolveAccess({ own: null, emailVerified: true, teamOwners: [] }, now).plan === "free");

  const base = { ownerPlan: "team" as const, ownerEmail: "Boss@x.co" };
  const four = ["a@x.co", "b@x.co", "c@x.co", "d@x.co"];
  check("seats: 4 members fill 5 seats; a 5th member is rejected",
    TEAM_SEATS === 5 && (checkNewMember({ ...base, members: four, email: "e@x.co" }) as { error?: string }).error === "full");
  const ok = checkNewMember({ ...base, members: four.slice(0, 3), email: "  New@Example.CO.ZA " });
  check("seats: 4th member accepted, email normalised", ok.ok && ok.email === "new@example.co.za");
  check("seats: owner can't add themselves", (checkNewMember({ ...base, members: [], email: "boss@X.co" }) as { error?: string }).error === "self");
  check("seats: duplicate rejected", (checkNewMember({ ...base, members: ["a@x.co"], email: "A@x.co" }) as { error?: string }).error === "duplicate");
  check("seats: invalid email rejected", (checkNewMember({ ...base, members: [], email: "nope" }) as { error?: string }).error === "invalid");
  check("seats: only Team owners can add", (checkNewMember({ ...base, ownerPlan: "pro", members: [], email: "a@x.co" }) as { error?: string }).error === "not-team");
}

// ---------- prices & dates ----------
{
  check("R49 / R199", formatPrice(PLANS.pro.priceMonthly) === "R49" && formatPrice(PLANS.team.priceMonthly) === "R199",
    `${formatPrice(49)} ${formatPrice(199)}`);
  check("R0 for Free", formatPrice(0) === "R0");
  check("thousands grouped with a non-breaking space", formatPrice(1990) === "R1\u00a0990" && formatPrice(1234567) === "R1\u00a0234\u00a0567", JSON.stringify(formatPrice(1990)));
  check("cents shown when present", formatPrice(49.5) === "R49,50", formatPrice(49.5));
  check("plans are in ZAR", PLANS.pro.currency === "ZAR" && PLANS.team.currency === "ZAR");
  check("year = 10 months", prepaidPrice("pro", 12) === 490 && prepaidPrice("team", 12) === 1990 && prepaidPrice("pro", 1) === 49);
  check("subunits", toSubunit(49) === 4900 && toSubunit(199) === 19900 && toSubunit(1990) === 199000);
  check("Team lists 5 seats", PLANS.team.features.includes("5 seats") && !PLANS.team.features.some((f) => /coming soon/i.test(f)));
  check("addMonths clamps month ends", addMonths(new Date("2027-01-31T10:00:00Z"), 1).toISOString() === "2027-02-28T10:00:00.000Z" &&
    addMonths(new Date("2026-03-15T00:00:00Z"), 12).toISOString() === "2027-03-15T00:00:00.000Z");
  check("billing date in SAST", formatBillingDate("2026-11-04T23:30:00Z") === "5 Nov 2026" && formatBillingDate("2026-11-04T21:59:00Z") === "4 Nov 2026", formatBillingDate("2026-11-04T23:30:00Z"));
}

// ---------- Paystack client (fake network) ----------
{
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (respond: (url: string) => { status: number; body: unknown } | "throw") =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const r = respond(String(url));
      if (r === "throw") throw new Error("offline");
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as typeof fetch;
  const cfg = {
    secretKey: SECRET,
    fetch: fake((url) => url.endsWith("/transaction/initialize")
      ? { status: 200, body: { status: true, message: "ok", data: { authorization_url: "https://checkout.paystack.com/x", access_code: "x", reference: "pw_1" } } }
      : url.includes("/verify/") ? { status: 200, body: { status: true, data: { status: "success", reference: "pw_1" } } }
      : url.includes("/manage/link") ? { status: 200, body: { status: true, data: { link: "https://paystack.com/manage/x" } } }
      : { status: 404, body: { status: false, message: "Not found" } }),
  };
  const ref = newReference();
  const init = await initializeTransaction(cfg, {
    email: "u@x.co", amount: 4900, reference: ref, callbackUrl: "https://pdf.example/settings/billing?ref=" + ref,
    metadata: { user_id: USER, plan: "pro", mode: "subscription" }, channels: SUBSCRIPTION_CHANNELS, plan: "PLN_pro",
  });
  const sent = JSON.parse(String(calls[0].init.body));
  const auth = new Headers(calls[0].init.headers).get("authorization");
  check("initialize: POST to api.paystack.co with Bearer secret", calls[0].url === "https://api.paystack.co/transaction/initialize" &&
    calls[0].init.method === "POST" && auth === `Bearer ${SECRET}`);
  check("initialize: ZAR, cents, plan, callback, metadata, card only", sent.currency === "ZAR" && sent.amount === "4900" &&
    sent.plan === "PLN_pro" && sent.callback_url.endsWith(ref) && JSON.parse(sent.metadata).user_id === USER &&
    JSON.stringify(sent.channels) === '["card"]');
  check("initialize: returns authorization_url", init.authorization_url === "https://checkout.paystack.com/x");
  check("once-off channels are South African ones", JSON.stringify(ONCE_OFF_CHANNELS) === '["card","apple_pay","eft","capitec_pay","qr"]');
  const v = await verifyTransaction(cfg, "pw_1");
  check("verify: GET /transaction/verify/:reference", calls[1].url === "https://api.paystack.co/transaction/verify/pw_1" && v.status === "success");
  const m = await subscriptionManageLink(cfg, "SUB_1");
  check("manage: GET /subscription/:code/manage/link", calls[2].url === "https://api.paystack.co/subscription/SUB_1/manage/link" && m.link.includes("manage"));
  let err: unknown = null;
  try { await verifyTransaction({ ...cfg, fetch: fake(() => ({ status: 400, body: { status: false, message: "Invalid key" } })) }, "pw_1"); } catch (e) { err = e; }
  check("API errors surface as PaystackError with message", err instanceof PaystackError && err.message === "Invalid key" && err.status === 400);
  err = null;
  try { await verifyTransaction({ ...cfg, fetch: fake(() => "throw") }, "pw_1"); } catch (e) { err = e; }
  check("network failure → PaystackError 502", err instanceof PaystackError && err.status === 502);
  check("plan codes map both ways only for known codes", planForCode("PLN_team", CODES) === "team" && planForCode("PLN_x", CODES) === null && planForCode(null, CODES) === null);
  check("references: ours are recognised, others not", isOurReference(ref) && !isOurReference("T_123") && !isOurReference("pw_../x"));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
