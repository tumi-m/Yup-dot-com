// POST /api/access/redeem: signed-in only, same-site only, a JSON body with a
// code, a limit on tries per account and per address, and short answers that
// never tell an unknown code from a revoked one (same message, same status,
// and at least the same time). The database does the real checks
// (tests/rls/rls.test.sql); this is the route around it.
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.test";
import { readFileSync } from "node:fs";
import {
  MIN_ANSWER_MS,
  REDEEM_BUCKET,
  REDEEM_LIMITS,
  handleRedeem,
  redeemErrorOf,
  type RedeemDeps,
} from "../lib/tester-redeem.ts";
import { REDEEM_ERRORS, REDEEM_TOO_MANY, REDEEM_UNAVAILABLE } from "../lib/tester-access.ts";
import { memoryUsageStore } from "../lib/usage.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const USER = { id: "5b0c8a8e-7d3f-4c55-9d6a-1f0e2a3b4c5d" };
const CODE = "K7QM-8XRP-2D4N-W9HC";
type DbAnswer = { data: unknown; error: { code?: string; message?: string } | null };
const ok: DbAnswer = { data: { plan: "pro", until: "2026-11-18T10:00:00+00:00", days: 30 }, error: null };
const refusal = (message: string): DbAnswer => ({ data: null, error: { code: "P0001", message } });

function setup(opts: { user?: { id: string } | null; db?: (args: { uid: string; code: string; dry_run: boolean }) => DbAnswer | Promise<DbAnswer>; minAnswerMs?: number } = {}) {
  const store = memoryUsageStore();
  const calls: { uid: string; code: string; dry_run: boolean }[] = [];
  const deps: RedeemDeps = {
    getUser: async () => (opts.user === undefined ? USER : opts.user),
    redeem: async (args) => {
      calls.push(args);
      return opts.db ? opts.db(args) : ok;
    },
    consume: (s, b, l, w) => store.consume(s, b, l, w),
    ipSubject: (req) => `ip:${req.headers.get("x-forwarded-for") ?? "?"}`,
    minAnswerMs: opts.minAnswerMs ?? 0,
  };
  return { deps, calls, store };
}
const SAME_SITE = { host: "pdfwizard.test", origin: "https://pdfwizard.test", "sec-fetch-site": "same-origin", "content-type": "application/json", "x-forwarded-for": "198.51.100.7" };
const post = (deps: RedeemDeps, body: unknown, headers: Record<string, string> = {}) =>
  handleRedeem(new Request("https://pdfwizard.test/api/access/redeem", {
    method: "POST",
    headers: { ...SAME_SITE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), deps);
const json = async (res: Response) => ({ status: res.status, body: await res.json(), cache: res.headers.get("cache-control") });

// ---------- Who may ask ----------
{
  const s = setup({ user: null });
  const r = await json(await post(s.deps, { code: CODE }));
  check("signed out: 401", r.status === 401 && s.calls.length === 0, r);
}
{
  const s = setup();
  const r = await post(s.deps, { code: CODE }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  check("another site's page: 403, nothing looked up", r.status === 403 && s.calls.length === 0, r.status);
  const form = await post(s.deps, `code=${CODE}`, { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" });
  check("a cross-site form post: 403", form.status === 403 && s.calls.length === 0, form.status);
  const plain = await post(s.deps, JSON.stringify({ code: CODE }), { "content-type": "text/plain" });
  check("a text/plain body (no preflight): 403", plain.status === 403 && s.calls.length === 0, plain.status);
}
{
  const s = setup();
  for (const [what, body] of [["no code", {}], ["not text", { code: 42 }], ["too long", { code: "A".repeat(500) }], ["not JSON", "{"], ["check not a boolean", { code: CODE, check: "yes" }]] as const) {
    const r = await json(await post(s.deps, body));
    check(`bad body (${what}): 400`, r.status === 400 && s.calls.length === 0, r);
  }
}

// ---------- Redeeming ----------
{
  const s = setup();
  const r = await json(await post(s.deps, { code: " k7qm 8xrp 2d4n w9hc " }));
  check("redeemed: plan and end date", r.status === 200 && r.body.plan === "pro" && r.body.until === "2026-11-18T10:00:00+00:00" && r.body.days === 30, r);
  check("never cached", r.cache === "no-store", r.cache);
  check("the database gets the user and the code, cleaned up", s.calls.length === 1 && s.calls[0].uid === USER.id &&
    s.calls[0].code === "K7QM8XRP2D4NW9HC" && s.calls[0].dry_run === false, s.calls);
}
{
  const s = setup();
  const r = await json(await post(s.deps, { code: CODE, check: true }));
  check("check: a dry run, says what it gives", r.status === 200 && r.body.check === true && r.body.plan === "pro" && s.calls[0].dry_run === true, r);
}
{
  const s = setup({ db: () => ({ data: { plan: "team", until: "2026-11-18T10:00:00+00:00", days: 14 }, error: null }) });
  const r = await json(await post(s.deps, { code: CODE }));
  check("a Team code says Team", r.body.plan === "team" && r.body.days === 14, r);
}

// ---------- Refusals ----------
for (const [db, reason] of [
  ["invalid_code", "invalid"],
  ["code_expired", "expired"],
  ["code_used_up", "used-up"],
  ["already_redeemed", "already-redeemed"],
] as const) {
  const s = setup({ db: () => refusal(db) });
  const r = await json(await post(s.deps, { code: CODE }));
  check(`${db}: 400, "${REDEEM_ERRORS[reason]}"`, r.status === 400 && r.body.reason === reason && r.body.error === REDEEM_ERRORS[reason], r);
}
check("only P0001 with a known reason is a refusal", redeemErrorOf({ code: "P0001", message: "code_used_up" }) === "used-up" &&
  redeemErrorOf({ code: "23505", message: "already_redeemed" }) === null && redeemErrorOf({ code: "P0001", message: "other" }) === null &&
  redeemErrorOf(null) === null);
{
  // Revoked and unknown codes: the database gives both invalid_code from the
  // same query; the route answers both identically and not faster than the floor.
  const unknown = setup({ db: () => refusal("invalid_code"), minAnswerMs: 120 });
  const revoked = setup({ db: async () => { await new Promise((r) => setTimeout(r, 30)); return refusal("invalid_code"); }, minAnswerMs: 120 });
  const t0 = Date.now();
  const a = await post(unknown.deps, { code: CODE });
  const t1 = Date.now();
  const b = await post(revoked.deps, { code: CODE });
  const t2 = Date.now();
  const [ta, tb] = [await a.text(), await b.text()];
  check("unknown and revoked: the same answer", a.status === b.status && ta === tb, [ta, tb]);
  check("both take the minimum time", t1 - t0 >= 115 && t2 - t1 >= 115, [t1 - t0, t2 - t1]);
  check("a malformed code: the same answer, without a lookup", await (async () => {
    const s = setup({ minAnswerMs: 120 });
    const t = Date.now();
    const r = await post(s.deps, { code: "nope" });
    return r.status === a.status && (await r.text()) === ta && Date.now() - t >= 115 && s.calls.length === 0;
  })());
  check(`the floor in production is ${MIN_ANSWER_MS} ms`, MIN_ANSWER_MS >= 300);
}
{
  const s = setup({ db: () => ({ data: null, error: { code: "42883", message: "function public.redeem_tester_code(uuid, text, boolean) does not exist" } }) });
  const r = await json(await post(s.deps, { code: CODE }));
  check("database trouble: 503, in our words only", r.status === 503 && r.body.error === REDEEM_UNAVAILABLE && !JSON.stringify(r.body).includes("function"), r);
}
{
  const s = setup({ db: () => { throw new Error("fetch failed"); } });
  const r = await json(await post(s.deps, { code: CODE }));
  check("network trouble: 503", r.status === 503 && r.body.error === REDEEM_UNAVAILABLE, r);
}
{
  const s = setup({ db: () => ({ data: { plan: "gold" }, error: null }) });
  const r = await json(await post(s.deps, { code: CODE }));
  check("an odd answer: 503, not success", r.status === 503, r);
}

// ---------- Tries ----------
{
  const s = setup({ db: () => refusal("invalid_code") });
  const statuses: number[] = [];
  for (let i = 0; i < REDEEM_LIMITS.user + 1; i++) statuses.push((await post(s.deps, { code: i % 2 ? CODE : "nope" })).status);
  check(`${REDEEM_LIMITS.user} tries a day per account, malformed ones too`, statuses.slice(0, REDEEM_LIMITS.user).every((x) => x === 400) &&
    statuses[REDEEM_LIMITS.user] === 429, statuses);
  const r = await json(await post(s.deps, { code: CODE }));
  check("then 429, without a lookup", r.status === 429 && r.body.error === REDEEM_TOO_MANY && s.calls.length === REDEEM_LIMITS.user / 2, [r, s.calls.length]);
  check("counted by account and by address", (await s.store.count(`u:${USER.id}`, REDEEM_BUCKET, "day")) === REDEEM_LIMITS.user &&
    (await s.store.count("ip:198.51.100.7", REDEEM_BUCKET, "day")) >= REDEEM_LIMITS.user);
}
{
  // Many accounts behind one address.
  const s = setup({ db: () => refusal("invalid_code") });
  let last = 0;
  for (let i = 0; i < REDEEM_LIMITS.ip + 1; i++) {
    s.deps.getUser = async () => ({ id: `user-${i}` });
    last = (await post(s.deps, { code: CODE })).status;
  }
  check(`${REDEEM_LIMITS.ip} tries a day per address, across accounts`, last === 429, last);
  const other = await post(s.deps, { code: CODE }, { "x-forwarded-for": "203.0.113.9" });
  check("another address still can", other.status === 400, other.status);
}
{
  const s = setup();
  s.deps.consume = async () => { throw new Error("db down"); };
  const r = await json(await post(s.deps, { code: CODE }));
  check("no counter, no tries: 503", r.status === 503 && s.calls.length === 0, r);
}

// ---------- The route ----------
const route = readFileSync(new URL("../app/api/access/redeem/route.ts", import.meta.url), "utf8");
check("the route redeems with the service role", /createAdminClient\(\)\.rpc\("redeem_tester_code", args\)/.test(route));
check("the route takes the user from the session", /getUser: getCurrentUser/.test(route));
check("the route has no GET (the code is never in a URL)", !/export (async )?function GET/.test(route));
const client = readFileSync(new URL("../components/TesterAccess.tsx", import.meta.url), "utf8");
check("no service key or admin client in the browser code", !/SERVICE_ROLE|createAdminClient|tester-redeem/.test(client));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll tester code route checks passed.");
