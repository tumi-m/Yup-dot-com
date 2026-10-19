// Tester access in the app's plan logic: the same rules as own_plan() and
// effective_plan() in the database. While it runs, the tester plan counts
// when it is higher than what is paid for (or a Team seat); it ends on its
// own at `until`; billing rows never change; buying stays possible and loses
// no paid time; a Team tester gives seats like a Team owner. Limits,
// watermark, AI and media allowances follow the plan, so they unlock too.
import { readFileSync } from "node:fs";
import {
  applyCharge, ownPlan, paidPlan, resolveAccess, summarize,
  type BillingPatch, type BillingRow, type BillingStore,
} from "../lib/billing.ts";
import { cardOffer, payOnceBlock, planBadge, planOnCards, planStatus, planTitle, subscribeBlock } from "../lib/billing-ui.ts";
import { LIMITS } from "../lib/limits.ts";
import { aiPolicy, claimEdit, memoryUsageStore } from "../lib/usage.ts";
import type { TesterAccess } from "../lib/tester-access.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const now = new Date("2026-10-19T10:00:00Z");
const day = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
const row = (extra: Partial<BillingRow> = {}): BillingRow => ({
  id: "u1", email: "t@x.co", subscription_plan: null, subscription_status: null, current_period_end: null,
  prepaid_plan: null, paid_until: null, paystack_customer_code: null, paystack_subscription_code: null,
  paystack_email_token: null, ...extra,
});
const tester = (plan: "pro" | "team", ms: number): TesterAccess => ({ plan, until: at(ms) });
const resolve = (own: BillingRow, teamOwners: BillingRow[] = [], when = now) => {
  const access = resolveAccess({ own, emailVerified: true, teamOwners }, when);
  return { access, billing: summarize(own, access, when) };
};

// ---------- Free + tester ----------
{
  const own = row({ tester: tester("pro", 30 * day) });
  const { access, billing } = resolve(own);
  check("Free + Pro tester: Pro", access.plan === "pro" && access.source === "tester", access);
  check("what is left after: Free", access.base.plan === "free" && access.base.source === null, access.base);
  check("own plan counts it (as own_plan())", ownPlan(own, now) === "pro" && paidPlan(own, now) === "free");
  check("Billing: Pro (tester)", planTitle(billing) === "Pro (tester)", planTitle(billing));
  check("Billing: until 18 Nov 2026, then Free", planStatus(billing)[0] === "Until 18 Nov 2026, then Free", planStatus(billing));
  check("badge: Pro (tester), until 18 Nov 2026", JSON.stringify(planBadge(access.plan, billing)) ===
    JSON.stringify({ name: "Pro (tester)", until: "until 18 Nov 2026" }), planBadge(access.plan, billing));
  check("Pro limits", LIMITS[access.plan].watermark === false && LIMITS[access.plan].maxFileBytes === LIMITS.pro.maxFileBytes);
}
{
  // The end, to the millisecond.
  const own = row({ tester: tester("pro", 1) });
  check("a millisecond before the end: Pro", resolve(own).access.plan === "pro");
  check("at the end: Free", resolve(own, [], new Date(now.getTime() + 1)).access.plan === "free");
  const ended = resolve(own, [], new Date(now.getTime() + day));
  check("after: Free, and the badge says Free", ended.access.plan === "free" && planBadge("free", ended.billing).name === "Free");
  check("after: Billing says when it ended", planTitle(ended.billing) === "Free" &&
    planStatus(ended.billing).includes("Pro (tester) ended 19 Oct 2026"), planStatus(ended.billing));
  check("after: Free limits again", LIMITS[ended.access.plan].watermark === true);
}

// ---------- Paid + tester ----------
{
  // Prepaid Pro, Team tester: Team, with Pro kept underneath.
  const own = row({ prepaid_plan: "pro", paid_until: at(60 * day), tester: tester("team", 10 * day) });
  const before = JSON.stringify({ ...own, tester: undefined });
  const { access, billing } = resolve(own);
  check("prepaid Pro + Team tester: Team", access.plan === "team" && access.source === "tester");
  check("then Pro", access.base.plan === "pro" && access.base.source === "prepaid");
  check("Billing: until 29 Oct, then Pro, and the paid term", JSON.stringify(planStatus(billing)) ===
    JSON.stringify(["Until 29 Oct 2026, then Pro", "Paid until 18 Dec 2026"]), planStatus(billing));
  check("the billing row is untouched", JSON.stringify({ ...own, tester: undefined }) === before);
  const later = resolve(own, [], new Date(now.getTime() + 11 * day));
  check("tester time over: paid Pro again", later.access.plan === "pro" && later.access.source === "prepaid");
}
{
  // Paying for the same plan: the paid plan is the source, tester time is listed.
  const own = row({ subscription_plan: "pro", subscription_status: "active", current_period_end: at(20 * day), paystack_subscription_code: "SUB_1", tester: tester("pro", 30 * day) });
  const { access, billing } = resolve(own);
  check("Pro subscription + Pro tester: the subscription shows", access.plan === "pro" && access.source === "subscription");
  check("and the tester time is listed", planStatus(billing).includes("Pro (tester) until 18 Nov 2026"), planStatus(billing));
  check("badge: plain Pro", planBadge(access.plan, billing).name === "Pro");
}
{
  const own = row({ subscription_plan: "team", subscription_status: "active", current_period_end: at(20 * day), tester: tester("pro", 30 * day) });
  check("Team subscription + Pro tester: Team (subscription)", resolve(own).access.source === "subscription");
}

// ---------- Team seats ----------
{
  const owner = row({ id: "owner", tester: tester("team", 5 * day) });
  const member = row({ id: "member" });
  check("a Team tester gives seats", resolve(member, [owner]).access.plan === "team");
  check("until it ends", resolve(member, [owner], new Date(now.getTime() + 6 * day)).access.plan === "free");
  const proTester = row({ id: "owner", tester: tester("pro", 5 * day) });
  check("a Pro tester gives none", resolve(member, [proTester]).access.plan === "free");
  // A seat outlasts tester time: it is what's left after.
  const seated = row({ id: "member", tester: tester("pro", 5 * day) });
  const paidOwner = row({ id: "owner", subscription_plan: "team", subscription_status: "active", current_period_end: at(30 * day) });
  const r = resolve(seated, [paidOwner]);
  check("Team seat + Pro tester: the seat shows", r.access.plan === "team" && r.access.source === "team");
  const seatedTeam = row({ id: "member", tester: tester("team", 5 * day) });
  const r2 = resolve(seatedTeam, [paidOwner]);
  check("Team seat + Team tester: the seat shows", r2.access.source === "team");
  const r3 = resolve(row({ id: "member", tester: tester("team", 5 * day) }), [row({ id: "owner", prepaid_plan: "pro", paid_until: at(9 * day) })]);
  check("then your Team seat (when there is one)", r3.access.source === "tester" && r3.access.base.plan === "free");
}
// The app reads seats with the owners' tester time, as effective_plan() does.
const store = readFileSync(new URL("../lib/billing-store.ts", import.meta.url), "utf8");
check("team owners are read with their tester access", /from\("tester_access"\)\.select\("user_id, plan, until"\)\.in\("user_id", ids\)/.test(store));
const profile = readFileSync(new URL("../lib/profile.ts", import.meta.url), "utf8");
check("the user's tester row is read as the user (RLS: own row only)", /supabase\.from\("tester_access"\)\.select\("plan, until"\)\.eq\("user_id", userId\)/.test(profile));
check("the seat lookup goes by what is paid, not by tester time", /paidPlan\(row, now\) !== "team"/.test(profile));

// ---------- Buying during tester access ----------
{
  const own = row({ tester: tester("pro", 30 * day) });
  const { access, billing } = resolve(own);
  check("cards show Free as the plan in use", planOnCards(access.plan, billing) === "free");
  const pro = cardOffer("pro", access.plan, billing);
  check("Pro can still be bought", pro.main === "subscribe" && pro.payOnce, pro);
  check("labelled plainly, and says when paid time starts", pro.text === "Subscribe to Pro" && pro.payOnceNote === "Paid time starts when you pay.", pro);
  const team = cardOffer("team", access.plan, billing);
  check("Team too", team.main === "subscribe" && team.payOnce && team.text === null, team);
  check("the checkout route allows both", subscribeBlock("pro", billing) === null && payOnceBlock("pro", billing) === null &&
    subscribeBlock("team", billing) === null && payOnceBlock("team", billing) === null);
}
{
  const s: BillingRow = row({ id: "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d", tester: tester("pro", 30 * day) });
  let saved: BillingRow = { ...s };
  const events = new Set<string>();
  const db: BillingStore = {
    async claimEvent(k) { if (events.has(k)) return false; events.add(k); return true; },
    async releaseEvent(k) { events.delete(k); },
    async getRow() { const { tester: _t, ...paid } = saved; return paid; }, // the store reads profiles only
    async findUserId() { return s.id; },
    async updateRow(_id, p: BillingPatch) { const { plan: _p, ...rest } = p; saved = { ...saved, ...rest }; },
  };
  await applyCharge({
    status: "success", reference: "pw_t1", amount: 4900, currency: "ZAR", paid_at: now.toISOString(),
    customer: { customer_code: "CUS_t" }, metadata: { user_id: s.id, plan: "pro", mode: "once", months: 1 },
  }, { store: db, planForCode: () => null, now: () => now });
  check("a month bought on tester time: a full month from today", saved.prepaid_plan === "pro" && saved.paid_until === "2026-11-19T10:00:00.000Z", saved.paid_until);
  check("tester time is not touched by a payment", saved.tester?.until === s.tester?.until);
  const after = resolve(saved, [], new Date(now.getTime() + 31 * day + 1));
  check("paid time outlasts tester time", resolve(saved, [], new Date(now.getTime() + 30 * day + 1)).access.plan === "pro" &&
    after.access.plan === "free");
}

// ---------- Limits follow the plan ----------
{
  const own = row({ tester: tester("team", 3 * day) });
  const tier = resolve(own).access.plan;
  check("AI: Team allowance", aiPolicy(tier, {}).day === LIMITS.team.aiAnswersPerDay);
  const edit = await claimEdit("u:u1", tier, "a".repeat(64), memoryUsageStore());
  check("edits: unlimited, no watermark", edit.allowed && edit.remaining === null && edit.watermark === false, edit);
  check("media: Pro downloads", LIMITS[tier].mediaDownloadsPerDay === LIMITS.pro.mediaDownloadsPerDay);
}
// Every server tier check goes through the profile's plan.
const tierSrc = readFileSync(new URL("../lib/tier.ts", import.meta.url), "utf8");
check("server tiers come from the resolved profile plan", /profile\?\.plan/.test(tierSrc) && /getProfile/.test(tierSrc));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll tester plan checks passed.");
