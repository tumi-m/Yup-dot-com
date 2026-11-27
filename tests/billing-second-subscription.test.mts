// Two subscription checkouts started in two tabs, both paid before either
// was applied, left two Paystack subscriptions renewing: the card charged
// twice every month, the second impossible to manage. Now the same
// subscription asked for again within 30 minutes gets the same checkout
// link; and a second one paid anyway isn't applied, is kept for the owner to
// refund, and its subscription is stopped in Paystack when it is created,
// whichever order the events come in. Nothing is refunded automatically.
import {
  DUPLICATE_START, checkoutMetadata, confirmCharge, handlePaystackEvent, resolveAccess, summarize,
  type BillingPatch, type BillingRow, type BillingStore, type DuplicateStart, type EventDeps,
} from "../lib/billing.ts";
import { CHECKOUT_REUSE_MS, paymentOutcome, reusableCheckout } from "../lib/billing-ui.ts";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
// The handler names each kept charge for the owner: not this test's output.
console.error = () => {};
console.info = () => {};

const SECRET = "sk_test_second";
const USER = "11111111-1111-4111-8111-111111111111";
const customer = { customer_code: "CUS_u" };
const codes = (c: string | null | undefined) => (c === "PLN_pro" ? "pro" : c === "PLN_team" ? "team" : null);
const ref = (c: string) => "pw_" + c.repeat(24);

function setup() {
  const row: BillingRow = {
    id: USER, email: "u@x.co", subscription_plan: null, subscription_status: null, current_period_end: null,
    prepaid_plan: null, paid_until: null, paystack_customer_code: null, paystack_subscription_code: null, paystack_email_token: null,
    start_authorization: null,
  };
  const events = new Set<string>();
  const seconds = new Map<string, DuplicateStart & { code: string | null }>();
  const store: BillingStore = {
    async claimEvent(k) { if (events.has(k)) return false; events.add(k); return true; },
    async releaseEvent(k) { events.delete(k); },
    async getRow() { return { ...row }; },
    async findUserId(by) {
      return (by.customerCode && by.customerCode === row.paystack_customer_code) || (by.subscriptionCode && by.subscriptionCode === row.paystack_subscription_code) ? USER : null;
    },
    async updateRow(_id, p: BillingPatch) { const { plan: _p, ...rest } = p; Object.assign(row, rest); },
    async recordDuplicateStart(d) { seconds.set(d.reference, { ...d, code: null }); },
    async findDuplicateStart(userId, plan, card) {
      return [...seconds.values()].find((d) => d.userId === userId && d.plan === plan && d.card === card && !d.code)?.reference ?? null;
    },
    async isDuplicateStart(reference) { return seconds.has(reference); },
    async resolveDuplicateStart(reference, code) { seconds.get(reference)!.code = code; },
  };
  const stopped: string[] = [];
  let clock = new Date("2026-11-01T08:00:00Z");
  const deps: EventDeps = {
    store, planForCode: codes, checkoutSecret: SECRET, now: () => clock,
    paystack: {
      async transaction() { throw new Error("not used"); },
      async disableSubscription(code, token) { stopped.push(`${code}/${token}`); },
    },
  };
  const deliver = (event: string, data: unknown) => {
    const raw = JSON.stringify({ event, data });
    return handlePaystackEvent(JSON.parse(raw), raw, deps);
  };
  const live = () => summarize(row, resolveAccess({ own: row, emailVerified: true, teamOwners: [] }, clock), clock);
  return { row, deps, deliver, seconds, stopped, live, at: (iso: string) => (clock = new Date(iso)) };
}
const first = (reference: string, paidAt: string, card = "AUTH_1", plan: "pro" | "team" = "pro") => ({
  status: "success", reference, amount: plan === "pro" ? 4900 : 19900, currency: "ZAR", paid_at: paidAt, customer,
  plan: { plan_code: plan === "pro" ? "PLN_pro" : "PLN_team" }, authorization: { authorization_code: card },
  metadata: JSON.stringify(checkoutMetadata(reference, { user_id: USER, plan, mode: "subscription" }, SECRET)),
});
const create = (code: string, next: string, card = "AUTH_1", plan = "PLN_pro") => ({
  subscription_code: code, email_token: "tok_" + code, status: "active", plan: { plan_code: plan }, customer,
  authorization: { authorization_code: card }, next_payment_date: next,
});
const renewal = (reference: string, paidAt: string) => ({ status: "success", reference, amount: 4900, currency: "ZAR", paid_at: paidAt, customer, plan: { plan_code: "PLN_pro" }, metadata: "" });

// ---------- Both tabs paid, their creates in the same order ----------
{
  const s = setup();
  const A = await s.deliver("charge.success", first(ref("a"), "2026-11-01T08:00:00Z"));
  const B = await s.deliver("charge.success", first(ref("b"), "2026-11-01T08:01:00Z"));
  check("the first tab's charge starts Pro", A.status === "applied" && s.live().plan === "pro");
  check("the second, paid while the first is live, isn't applied", B.status === "ignored" && (B as { reason: string }).reason === DUPLICATE_START, B);
  check("…and is kept for a refund, with its amount", s.seconds.get(ref("b"))?.amount === 4900 && s.seconds.get(ref("b"))?.plan === "pro");
  const cA = await s.deliver("subscription.create", create("SUB_A", "2026-12-01T08:00:00Z"));
  const cB = await s.deliver("subscription.create", create("SUB_B", "2026-12-01T08:01:00Z"));
  check("the first subscription is the account's", cA.status === "applied" && s.row.paystack_subscription_code === "SUB_A", cA);
  check("the second is stopped in Paystack, so it never renews", cB.status === "ignored" && JSON.stringify(s.stopped) === '["SUB_B/tok_SUB_B"]', { cB, stopped: s.stopped });
  check("and noted against the kept charge", s.seconds.get(ref("b"))?.code === "SUB_B");
  s.at("2026-12-01T09:00:00Z");
  const rA = await s.deliver("charge.success", renewal("T_A2", "2026-12-01T08:00:00Z"));
  check("the first renews as before", rA.status === "applied" && s.row.current_period_end === "2027-01-01T08:00:00.000Z" && s.live().plan === "pro");
  const replay = await s.deliver("subscription.create", create("SUB_B", "2026-12-01T08:01:00Z"));
  const replayCharge = await s.deliver("charge.success", first(ref("b"), "2026-11-01T08:01:00Z"));
  check("replays of the second's events change nothing", replay.status === "duplicate" && replayCharge.status === "duplicate" && s.stopped.length === 1, { replay, replayCharge });
}

// ---------- The creates the other way round ----------
{
  const s = setup();
  await s.deliver("charge.success", first(ref("c"), "2026-11-01T08:00:00Z"));
  await s.deliver("charge.success", first(ref("d"), "2026-11-01T08:01:00Z"));
  const cD = await s.deliver("subscription.create", create("SUB_D", "2026-12-01T08:01:00Z"));
  const cC = await s.deliver("subscription.create", create("SUB_C", "2026-12-01T08:00:00Z"));
  check("whichever create comes first is the account's", cD.status === "applied" && s.row.paystack_subscription_code === "SUB_D", cD);
  check("the other is stopped: one subscription renews", cC.status === "ignored" && JSON.stringify(s.stopped) === '["SUB_C/tok_SUB_C"]', { cC, stopped: s.stopped });
}

// ---------- The second's create before its own charge ----------
{
  const s = setup();
  await s.deliver("charge.success", first(ref("e"), "2026-11-01T08:00:00Z"));
  await s.deliver("subscription.create", create("SUB_E", "2026-12-01T08:00:00Z"));
  const early = await s.deliver("subscription.create", create("SUB_F", "2026-12-01T08:02:00Z"));
  check("a create on this card while the subscription is live waits for its charge (sent again)", early.status === "retry" && s.row.paystack_subscription_code === "SUB_E", early);
  const F = await s.deliver("charge.success", first(ref("f"), "2026-11-01T08:02:00Z"));
  const again = await s.deliver("subscription.create", create("SUB_F", "2026-12-01T08:02:00Z"));
  check("then its charge is kept and the create, sent again, is stopped",
    F.status === "ignored" && again.status === "ignored" && JSON.stringify(s.stopped) === '["SUB_F/tok_SUB_F"]' && s.row.paystack_subscription_code === "SUB_E", { F, again, stopped: s.stopped });
}

// ---------- A second tab on another plan ----------
{
  const s = setup();
  await s.deliver("charge.success", first(ref("1"), "2026-11-01T08:00:00Z"));
  const team = await s.deliver("charge.success", first(ref("2"), "2026-11-01T08:01:00Z", "AUTH_1", "team"));
  check("Team paid in a second tab while Pro is live: kept, not applied", team.status === "ignored" && s.row.subscription_plan === "pro" && s.seconds.get(ref("2"))?.plan === "team");
  await s.deliver("subscription.create", create("SUB_P", "2026-12-01T08:00:00Z"));
  await s.deliver("subscription.create", create("SUB_T", "2026-12-01T08:01:00Z", "AUTH_1", "PLN_team"));
  check("its Team subscription is stopped", JSON.stringify(s.stopped) === '["SUB_T/tok_SUB_T"]' && s.row.paystack_subscription_code === "SUB_P", s.stopped);
}

// ---------- Someone else's subscription on this customer isn't touched ----------
{
  const s = setup();
  await s.deliver("charge.success", first(ref("3"), "2026-11-01T08:00:00Z"));
  await s.deliver("charge.success", first(ref("4"), "2026-11-01T08:01:00Z"));
  await s.deliver("subscription.create", create("SUB_OWN", "2026-12-01T08:00:00Z"));
  const other = await s.deliver("subscription.create", create("SUB_OTHER", "2026-12-01T08:00:00Z", "AUTH_someone_else"));
  check("a create paid with another card is not stopped", other.status === "ignored" && s.stopped.length === 0, other);
}

// ---------- Paystack can't stop it right now ----------
{
  const s = setup();
  await s.deliver("charge.success", first(ref("5"), "2026-11-01T08:00:00Z"));
  await s.deliver("charge.success", first(ref("6"), "2026-11-01T08:01:00Z"));
  await s.deliver("subscription.create", create("SUB_5", "2026-12-01T08:00:00Z"));
  const realStop = s.deps.paystack!.disableSubscription;
  s.deps.paystack!.disableSubscription = async () => { throw new Error("Paystack is down"); };
  let threw = false;
  try { await s.deliver("subscription.create", create("SUB_6", "2026-12-01T08:01:00Z")); } catch { threw = true; }
  check("stopping fails: an error, so Paystack sends the create again", threw && s.seconds.get(ref("6"))?.code === null);
  s.deps.paystack!.disableSubscription = realStop;
  const retried = await s.deliver("subscription.create", create("SUB_6", "2026-12-01T08:01:00Z"));
  check("…and the retry stops it", retried.status === "ignored" && JSON.stringify(s.stopped) === '["SUB_6/tok_SUB_6"]', s.stopped);
}

// ---------- The second tab's return page ----------
{
  const s = setup();
  await s.deliver("charge.success", first(ref("7"), "2026-11-01T08:00:00Z"));
  const own = await confirmCharge(first(ref("8"), "2026-11-01T08:01:00Z"), USER, "pro", s.deps);
  check("returning from the second checkout: told it's a second subscription", own.status === "ignored" && (own as { reason: string }).reason === DUPLICATE_START, own);
  await s.deliver("charge.success", first(ref("9"), "2026-11-01T08:02:00Z"));
  const afterWebhook = await confirmCharge(first(ref("9"), "2026-11-01T08:02:00Z"), USER, "pro", s.deps);
  check("…also when the webhook kept it first (not \"Payment received\")", afterWebhook.status === "ignored", afterWebhook);
  check("the return page reads it as a second subscription", paymentOutcome(409, "second-subscription") === "second-subscription");
  const route = readFileSync(new URL("../app/api/billing/verify/route.ts", import.meta.url), "utf8");
  check("the verify route answers it so", /result\.reason === DUPLICATE_START\) return json\(\{ status: "second-subscription" \}/.test(route));
}

// ---------- Prevention: one checkout link at a time ----------
{
  const now = new Date("2026-11-01T08:10:00Z");
  const link = { request: "pro:subscription", reference: ref("0"), url: "https://checkout.paystack.com/abc", created_at: "2026-11-01T08:00:00Z" };
  check("the same subscription asked for again within 30 minutes: the same link", reusableCheckout(link, "pro:subscription", now));
  check("another plan: a new link", !reusableCheckout(link, "team:subscription", now));
  check("after 30 minutes: a new link", !reusableCheckout(link, "pro:subscription", new Date(Date.parse(link.created_at) + CHECKOUT_REUSE_MS + 1000)));
  check("never a link that isn't Paystack's https checkout", !reusableCheckout({ ...link, url: "javascript:alert(1)" }, "pro:subscription", now));
  check("none kept: a new link", !reusableCheckout(null, "pro:subscription", now));
  const checkout = readFileSync(new URL("../app/api/billing/checkout/route.ts", import.meta.url), "utf8");
  check("checkout hands the kept link out for subscriptions, and keeps each new one",
    /if \(input\.mode === "subscription"\) \{\s*const pending = await getPendingCheckout/.test(checkout) && /savePendingCheckout\(account\.user\.id/.test(checkout));
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll second subscription checks passed.");
