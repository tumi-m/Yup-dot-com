// A refund in Paystack (refund.processed) changed nothing here, so everyone
// the refund policy refunds kept the time they had paid for. A full refund
// now takes that time away: a term paid once comes off paid_until; the charge
// that paid the current subscription period ends it now and stops the
// subscription in Paystack. Partial refunds and refunds of earlier charges
// change no access, and each refund applies once, in whatever order its
// events come.
import {
  addMonths, applyCharge, checkoutMetadata, handlePaystackEvent, resolveAccess, summarize,
  type BillingPatch, type BillingRow, type BillingStore, type DuplicateStart, type EventDeps,
} from "../lib/billing.ts";

// The handler logs what it leaves unchanged: not this test's output.
console.info = () => {};

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const SECRET = "sk_test_refunds";
const USER = "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d";
const customer = { customer_code: "CUS_u", email: "u@x.co" };
const authorization = { authorization_code: "AUTH_u" };
const codes = (c: string | null | undefined) => (c === "PLN_pro" ? "pro" : c === "PLN_team" ? "team" : null);

function setup() {
  const row: BillingRow = {
    id: USER, email: "u@x.co", subscription_plan: null, subscription_status: null, current_period_end: null,
    prepaid_plan: null, paid_until: null, paystack_customer_code: null, paystack_subscription_code: null, paystack_email_token: null,
    start_authorization: null,
  };
  const events = new Set<string>();
  const store: BillingStore = {
    async claimEvent(k) { if (events.has(k)) return false; events.add(k); return true; },
    async releaseEvent(k) { events.delete(k); },
    async getRow() { return { ...row }; },
    async findUserId(by) {
      return (by.customerCode && by.customerCode === row.paystack_customer_code) || (by.subscriptionCode && by.subscriptionCode === row.paystack_subscription_code) ? USER : null;
    },
    async updateRow(_id, p: BillingPatch) { const { plan: _p, ...rest } = p; Object.assign(row, rest); },
    async isDuplicateStart(r) { return kept.some((k) => k.reference === r && k.reason !== "refunded"); },
    async recordDuplicateStart(d) { kept.push({ ...d, code: null }); },
    async findDuplicateStart(u, plan) { return kept.find((k) => k.userId === u && k.plan === plan && !k.code)?.reference ?? null; },
    async resolveDuplicateStart(r, code) { kept.find((k) => k.reference === r)!.code = code; },
  };
  const kept: (DuplicateStart & { code: string | null })[] = [];
  const refundsMade = new Map<string, number[]>();
  /** Other customers' refunds on the same page (set per case). */
  let others: Record<string, unknown>[] = [];
  /** Page one only: refunds past it aren't fetched. */
  let pageSize = 50;
  const refundPage = () =>
    [...others, ...[...refundsMade].flatMap(([reference, amounts]) => amounts.map((amount) => ({ transaction_reference: reference, amount, status: "processed" })))].slice(0, pageSize);
  // Paystack: the transactions it knows, and the subscriptions it was asked to stop.
  const transactions = new Map<string, Record<string, unknown>>();
  const stopped: string[] = [];
  let clock = new Date("2026-11-01T08:00:00Z");
  const deps: EventDeps = {
    store, planForCode: codes, checkoutSecret: SECRET, now: () => clock,
    paystack: {
      async transaction(reference) {
        const tx = transactions.get(reference);
        if (!tx) throw new Error("Transaction reference not found");
        return tx;
      },
      async disableSubscription(code, token) { stopped.push(`${code}/${token}`); },
      // Paystack's list isn't filtered by transaction: it is the integration's
      // latest refunds, everyone's, newest first, a page at a time.
      async refunds() { return refundPage(); },
    },
  };
  const deliver = (event: string, data: unknown) => {
    const raw = JSON.stringify({ event, data });
    return handlePaystackEvent(JSON.parse(raw), raw, deps);
  };
  /** A charge Paystack took, applied through its webhook unless `apply` is false. */
  async function pay(tx: Record<string, unknown>, apply = true) {
    transactions.set(tx.reference as string, tx);
    return apply ? deliver("charge.success", tx) : null;
  }
  const refund = (reference: string, amount: number, extra: Record<string, unknown> = {}) => {
    if (!extra.status || extra.status === "processed") refundsMade.set(reference, [...(refundsMade.get(reference) ?? []), amount]);
    return deliver("refund.processed", { status: "processed", transaction_reference: reference, amount: String(amount), currency: "ZAR", customer: { email: "u@x.co" }, ...extra });
  };
  const plan = () => resolveAccess({ own: row, emailVerified: true, teamOwners: [] }, clock).plan;
  return { row, deps, deliver, pay, refund, plan, stopped, kept, setOthers: (o: Record<string, unknown>[]) => (others = o), setPageSize: (n: number) => (pageSize = n), refundsMade, at: (iso: string) => (clock = new Date(iso)) };
}
const ref = (c: string) => "pw_" + c.repeat(24);
const once = (reference: string, plan: "pro" | "team", months: 1 | 12, amount: number, paidAt: string) => ({
  status: "success", reference, amount, currency: "ZAR", paid_at: paidAt, customer, authorization,
  metadata: JSON.stringify(checkoutMetadata(reference, { user_id: USER, plan, mode: "once", months }, SECRET)),
});
const firstCharge = (reference: string, paidAt: string) => ({
  status: "success", reference, amount: 4900, currency: "ZAR", paid_at: paidAt, customer, authorization, plan: { plan_code: "PLN_pro" },
  metadata: JSON.stringify(checkoutMetadata(reference, { user_id: USER, plan: "pro", mode: "subscription" }, SECRET)),
});

// ---------- A month paid once, refunded within the week ----------
{
  const s = setup();
  await s.pay(once(ref("a"), "pro", 1, 4900, "2026-11-01T08:00:00Z"));
  check("bought: Pro until 1 Dec", s.plan() === "pro" && s.row.paid_until === "2026-12-01T08:00:00.000Z", s.row.paid_until);
  s.at("2026-11-03T08:00:00Z");
  const r = await s.refund(ref("a"), 4900);
  check("refunded in full: the month comes off, ending now", r.status === "applied" && s.row.paid_until === "2026-11-03T08:00:00.000Z" && s.plan() === "free", { r, until: s.row.paid_until });
  const again = await s.refund(ref("a"), 4900);
  check("the same refund delivered again changes nothing", again.status === "duplicate" && s.row.paid_until === "2026-11-03T08:00:00.000Z", again);
}

// ---------- A year, then a month more: refunding the month leaves the year ----------
{
  const s = setup();
  await s.pay(once(ref("b"), "pro", 12, 49000, "2026-11-01T08:00:00Z"));
  await s.pay(once(ref("c"), "pro", 1, 4900, "2026-11-02T08:00:00Z"));
  check("a year and a month: until 1 Dec 2027", s.row.paid_until === "2027-12-01T08:00:00.000Z", s.row.paid_until);
  s.at("2026-11-04T08:00:00Z");
  await s.refund(ref("c"), 4900);
  check("the month refunded: the year is left", s.row.paid_until === "2027-11-01T08:00:00.000Z" && s.plan() === "pro", s.row.paid_until);
}

// ---------- Pro time carried onto Team, then the Pro year refunded ----------
{
  const s = setup();
  await s.pay(once(ref("d"), "pro", 12, 49000, "2026-11-01T08:00:00Z"));
  await s.pay(once(ref("e"), "team", 1, 19900, "2026-11-01T08:00:00Z"));
  const before = new Date(s.row.paid_until!).getTime();
  await s.refund(ref("d"), 49000);
  const year = new Date("2027-11-01T08:00:00Z").getTime() - new Date("2026-11-01T08:00:00Z").getTime();
  const taken = before - new Date(s.row.paid_until!).getTime();
  check("the Pro year comes off the Team time at the price ratio (49/199)", Math.abs(taken - Math.floor(year * 49 / 199)) < 2 * 86400_000, { taken, expected: year * 49 / 199 });
  check("…leaving the Team month paid for", s.row.prepaid_plan === "team" && s.plan() === "team");
}

// ---------- A partial refund ----------
{
  const s = setup();
  await s.pay(once(ref("f"), "pro", 12, 49000, "2026-11-01T08:00:00Z"));
  const r = await s.refund(ref("f"), 10000);
  check("a partial refund changes no access", r.status === "ignored" && /partial/.test((r as { reason: string }).reason) && s.row.paid_until === "2027-11-01T08:00:00.000Z", r);
}

// ---------- A subscription's first charge, refunded ----------
{
  const s = setup();
  await s.pay(firstCharge(ref("g"), "2026-11-01T08:00:00Z"));
  await s.deliver("subscription.create", {
    subscription_code: "SUB_g", email_token: "tok_g", status: "active", plan: { plan_code: "PLN_pro" }, customer, authorization, next_payment_date: "2026-12-01T08:00:00Z",
  });
  s.at("2026-11-04T08:00:00Z");
  const r = await s.refund(ref("g"), 4900);
  const billing = summarize(s.row, resolveAccess({ own: s.row, emailVerified: true, teamOwners: [] }, new Date("2026-11-04T08:00:00Z")), new Date("2026-11-04T08:00:00Z"));
  check("the period it paid for ends now", r.status === "applied" && s.row.current_period_end === "2026-11-04T08:00:00.000Z" && s.row.subscription_status === "cancelled" && s.plan() === "free", { r, row: s.row });
  check("and Paystack is asked to stop the subscription, so it isn't charged again", JSON.stringify(s.stopped) === '["SUB_g/tok_g"]', s.stopped);
  check("Billing shows nothing left to charge; a new subscription can start", billing.subscription?.live === false && !billing.subscription.manageable, billing.subscription);
  // Paystack then says the subscription was disabled: nothing changes back.
  await s.deliver("subscription.disable", { subscription_code: "SUB_g", status: "complete", customer });
  check("Paystack's own disable event after it keeps it ended", s.plan() === "free" && s.row.subscription_status === "complete");
}

// ---------- An earlier renewal refunded: the current period stays ----------
{
  const s = setup();
  await s.pay(firstCharge(ref("h"), "2026-11-01T08:00:00Z"));
  await s.deliver("subscription.create", {
    subscription_code: "SUB_h", email_token: "tok_h", status: "active", plan: { plan_code: "PLN_pro" }, customer, authorization, next_payment_date: "2026-12-01T08:00:00Z",
  });
  s.at("2026-12-01T09:00:00Z");
  await s.pay({ status: "success", reference: "T_renew1", amount: 4900, currency: "ZAR", paid_at: "2026-12-01T08:00:00Z", customer, plan: { plan_code: "PLN_pro" }, metadata: "" });
  check("renewed to 1 Jan", s.row.current_period_end === "2027-01-01T08:00:00.000Z", s.row.current_period_end);
  const r = await s.refund(ref("h"), 4900);
  check("refunding November's charge leaves the paid December alone", r.status === "ignored" && s.row.current_period_end === "2027-01-01T08:00:00.000Z" && s.plan() === "pro" && s.stopped.length === 0, r);
  const renewal = await s.refund("T_renew1", 4900);
  check("refunding December's renewal ends it now and stops the subscription",
    renewal.status === "applied" && s.plan() === "free" && JSON.stringify(s.stopped) === '["SUB_h/tok_h"]', { renewal, stopped: s.stopped });
}

// ---------- Out of order: the refund before the charge's own webhook ----------
{
  const s = setup();
  await s.pay(once(ref("i"), "pro", 1, 4900, "2026-11-01T08:00:00Z"), false);
  const r = await s.refund(ref("i"), 4900);
  check("a refund before its charge was applied", r.status === "ignored", r);
  const late = await s.deliver("charge.success", once(ref("i"), "pro", 1, 4900, "2026-11-01T08:00:00Z"));
  check("…keeps the late charge from giving the month", late.status === "duplicate" && s.plan() === "free" && s.row.paid_until === null, { late, until: s.row.paid_until });
}

// ---------- Paystack can't be asked, or doesn't know the payment ----------
{
  const s = setup();
  await s.pay(once(ref("j"), "pro", 1, 4900, "2026-11-01T08:00:00Z"));
  const { paystack: _p, ...noPaystack } = s.deps;
  const raw = JSON.stringify({ event: "refund.processed", data: { status: "processed", transaction_reference: ref("j"), amount: "4900", currency: "ZAR" } });
  const waiting = await handlePaystackEvent(JSON.parse(raw), raw, noPaystack);
  check("without Paystack to ask, the refund waits (sent again later)", waiting.status === "retry" && s.plan() === "pro", waiting);
  let threw = false;
  try { await s.refund(ref("z"), 4900); } catch { threw = true; }
  check("a payment Paystack can't find is an error (sent again), not a guess", threw);
  const pending = await s.refund(ref("j"), 4900, { status: "pending" });
  check("a refund not yet processed changes nothing", pending.status === "ignored" && s.plan() === "pro");
  const after = await s.refund(ref("j"), 4900);
  check("and once processed it applies", after.status === "applied" && s.plan() === "free", after);
}

// ---------- Charged twice: two renewals the same month, the extra refunded ----------
// A renewal doesn't say which subscription it came from: refunding the
// extra one ended access and stopped the real subscription. Only the charge
// recorded as paying the current period ends it now.
{
  const s = setup();
  await s.pay(firstCharge(ref("k"), "2026-11-01T08:00:00Z"));
  await s.deliver("subscription.create", {
    subscription_code: "SUB_k", email_token: "tok_k", status: "active", plan: { plan_code: "PLN_pro" }, customer, authorization, next_payment_date: "2026-12-01T08:00:00Z",
  });
  s.at("2026-12-01T09:00:00Z");
  await s.pay({ status: "success", reference: "T_k1", amount: 4900, currency: "ZAR", paid_at: "2026-12-01T08:00:00Z", customer, plan: { plan_code: "PLN_pro" }, metadata: "" });
  await s.pay({ status: "success", reference: "T_k2", amount: 4900, currency: "ZAR", paid_at: "2026-12-01T08:05:00Z", customer, plan: { plan_code: "PLN_pro" }, metadata: "" });
  s.at("2026-12-03T09:00:00Z");
  const extra = await s.refund("T_k2", 4900);
  check("refunding the extra charge changes no access and stops nothing", extra.status === "ignored" && s.plan() === "pro" && s.row.subscription_status === "active" && s.stopped.length === 0, { extra, row: s.row, stopped: s.stopped });
}

// ---------- Refunded before Paystack created the subscription ----------
{
  const s = setup();
  await s.pay(firstCharge(ref("l"), "2026-11-01T08:00:00Z"));
  s.at("2026-11-02T08:00:00Z");
  const r = await s.refund(ref("l"), 4900);
  check("the first charge refunded before its create: access ends", r.status === "applied" && s.plan() === "free", r);
  const c = await s.deliver("subscription.create", {
    subscription_code: "SUB_l", email_token: "tok_l", status: "active", plan: { plan_code: "PLN_pro" }, customer, authorization, next_payment_date: "2026-12-01T08:00:00Z",
  });
  check("…and its subscription is stopped when Paystack creates it", c.status === "ignored" && JSON.stringify(s.stopped) === '["SUB_l/tok_l"]', { c, stopped: s.stopped });
  check("…kept as refunded, so it isn't listed as one to refund", s.kept[0]?.reason === "refunded" && s.kept[0]?.code === "SUB_l");
}
{
  const s = setup();
  await s.pay(firstCharge(ref("m"), "2026-11-01T08:00:00Z"), false);
  await s.refund(ref("m"), 4900);
  const late = await s.deliver("charge.success", firstCharge(ref("m"), "2026-11-01T08:00:00Z"));
  const c = await s.deliver("subscription.create", {
    subscription_code: "SUB_m", email_token: "tok_m", status: "active", plan: { plan_code: "PLN_pro" }, customer, authorization, next_payment_date: "2026-12-01T08:00:00Z",
  });
  check("refunded before its charge was applied: no Pro, and its subscription is stopped",
    late.status === "duplicate" && s.plan() === "free" && JSON.stringify(s.stopped) === '["SUB_m/tok_m"]', { late, c, stopped: s.stopped });
}

// ---------- Partial refunds that add up to the whole payment ----------
{
  const s = setup();
  await s.pay(once(ref("n"), "pro", 1, 4900, "2026-11-01T08:00:00Z"));
  s.at("2026-11-02T08:00:00Z");
  const half = await s.refund(ref("n"), 2400, { id: 1 });
  check("half refunded: access unchanged", half.status === "ignored" && s.plan() === "pro");
  const rest = await s.refund(ref("n"), 2500, { id: 2 });
  check("the rest refunded: together a full refund, the month comes off", rest.status === "applied" && s.plan() === "free", rest);
}

// ---------- Other customers' refunds in Paystack's list ----------
// The list has no filter by transaction: a big refund to someone else must
// not make this partial refund look full.
{
  const s = setup();
  await s.pay({ ...once(ref("o"), "pro", 12, 49000, "2026-11-01T08:00:00Z"), id: 7001 });
  s.setOthers([
    { transaction_reference: "T_someone_else", transaction: 9999, amount: 199000, status: "processed" },
    { transaction_reference: ref("p"), transaction: 9998, amount: 49000, status: "processed" },
  ]);
  const part = await s.refund(ref("o"), 10000);
  check("others' refunds (larger than this payment) don't count: still partial", part.status === "ignored" && s.plan() === "pro", part);
  s.setOthers([
    { transaction_reference: "T_someone_else", transaction: 9999, amount: 199000, status: "processed" },
    { transaction: 7001, amount: 39000, status: "processed" },
    { transaction_reference: ref("o"), transaction: 7001, amount: 5000, status: "pending" },
  ]);
  const byId = await s.refund(ref("o"), 39000);
  check("refunds matched by the payment's transaction id add up (pending ones don't count)", byId.status === "applied" && s.plan() === "free", byId);
}
{
  const s = setup();
  await s.pay(once(ref("q"), "pro", 1, 4900, "2026-11-01T08:00:00Z"));
  s.at("2026-11-02T08:00:00Z");
  await s.refund(ref("q"), 2400, { id: 1 });
  // Fifty other refunds since push this payment's first part to page two, which isn't fetched.
  s.setOthers(Array.from({ length: 50 }, (_, i) => ({ transaction_reference: `T_other_${i}`, amount: 100000, status: "processed" })));
  const second = await s.refund(ref("q"), 2500, { id: 2 });
  check("this payment's earlier refund on a page not fetched: this refund alone, still partial", second.status === "ignored" && s.plan() === "pro", second);
  s.setOthers([{ transaction_reference: "T_other", amount: 100000, status: "processed" }]);
  s.setPageSize(1);
  const none = await s.refund(ref("q"), 4900, { id: 3 });
  check("no matching item in the list: this refund alone decides (here, in full)", none.status === "applied" && s.plan() === "free", none);
}

// The month of a term: the same calendar months it was bought for.
check("a term comes off in calendar months", addMonths(new Date("2027-03-31T08:00:00Z"), -1).toISOString() === "2027-02-28T08:00:00.000Z");
void applyCharge;

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll refund checks passed.");
