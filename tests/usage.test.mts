/**
 * Usage counters (lib/usage.ts): the in-memory fallback, the Supabase path
 * against a fake RPC layer that mirrors public.consume_usage / refund_usage /
 * usage_count, guest IP hashing, AI allowances (day, month, burst, site-wide)
 * with refunds, the daily edit allowance and the watermark decision by tier.
 */
import {
  aiPolicy, aiRemaining, claimAiAnswer, claimEdit, consumeDaily, hashIp, memoryUsageStore, normalizeIp,
  periodStart, setUsageStore, supabaseUsageStore, usageStore, usageSubject, withFallback,
  AI_BUSY_MESSAGE, AI_BURST_MESSAGE, type RpcClient, type UsageStore, type UsageWindow,
} from "../lib/usage.ts";
import { LIMITS, type Tier } from "../lib/limits.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 9, 5, 10, 0, 0); // 5 Oct 2026, 10:00 UTC
const clock = (start = T0) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), set: (t: number) => (now = t) };
};
const DOC_A = "a".repeat(64);
const DOC_B = "b".repeat(64);
const DOC_C = "c".repeat(64);
const noEnv = {} as NodeJS.ProcessEnv;

/**
 * Mirrors the SQL functions: one row per (key, bucket, period, period_start),
 * consume counts only under the limit and returns uses left or -1, refund
 * never goes below zero. Records every call.
 */
function fakeRpc(now: () => number, opts: { fail?: boolean } = {}) {
  const rows = new Map<string, number>();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const id = (a: Record<string, unknown>) => `${a.p_key}|${a.p_bucket}|${a.p_window}|${periodStart(a.p_window as UsageWindow, now())}`;
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (opts.fail) return Promise.resolve({ data: null, error: { message: "function public.consume_usage does not exist" } });
      if (!["minute", "day", "month"].includes(args.p_window as string)) return Promise.resolve({ data: null, error: { message: "unknown window" } });
      const k = id(args);
      const used = rows.get(k) ?? 0;
      if (fn === "consume_usage") {
        const limit = args.p_limit as number;
        if (limit <= 0 || used >= limit) return Promise.resolve({ data: -1, error: null });
        rows.set(k, used + 1);
        return Promise.resolve({ data: limit - used - 1, error: null });
      }
      if (fn === "refund_usage") {
        if (used > 0) rows.set(k, used - 1);
        return Promise.resolve({ data: Math.max(0, used - 1), error: null });
      }
      if (fn === "usage_count") return Promise.resolve({ data: used, error: null });
      return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
    },
  };
  return { client, rows, calls };
}

// ---------- periods ----------
check("period: UTC day start", periodStart("day", T0) === Date.UTC(2026, 9, 5));
check("period: UTC month start", periodStart("month", T0) === Date.UTC(2026, 9, 1));
check("period: minute start", periodStart("minute", T0 + 59_999) === T0 && periodStart("minute", T0 + MIN) === T0 + MIN);

// ---------- memory store ----------
{
  const c = clock();
  const m = memoryUsageStore(c.now);
  const got = [await m.consume("u:1", "x", 2, "day"), await m.consume("u:1", "x", 2, "day"), await m.consume("u:1", "x", 2, "day")];
  check("memory: counts down to 0 then -1", got.join(",") === "1,0,-1", got.join(","));
  check("memory: refused use not counted", (await m.count("u:1", "x", "day")) === 2);
  await m.refund("u:1", "x", "day");
  check("memory: refund gives one back", (await m.count("u:1", "x", "day")) === 1 && (await m.consume("u:1", "x", 2, "day")) === 0);
  await m.refund("u:2", "x", "day");
  check("memory: refund never goes negative", (await m.count("u:2", "x", "day")) === 0);
  check("memory: subjects and buckets are separate", (await m.consume("u:2", "x", 2, "day")) === 1 && (await m.consume("u:1", "y", 2, "day")) === 1);
  c.advance(DAY);
  check("memory: a new UTC day starts fresh", (await m.consume("u:1", "x", 2, "day")) === 1);
  check("memory: Infinity limit never refuses", (await m.consume("u:1", "z", Infinity, "day")) === Infinity);
}

// ---------- default store ----------
{
  const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  setUsageStore(null);
  const s = usageStore();
  const a = await s.consume("u:default", "x", 1, "day");
  const b = await s.consume("u:default", "x", 1, "day");
  check("default: without Supabase, counts in memory", a === 0 && b === -1 && usageStore() === s);
  if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
  if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
}

// ---------- Supabase store (fake RPC) ----------
{
  const c = clock();
  const { client, calls } = fakeRpc(c.now);
  const s = supabaseUsageStore(client);
  const r = [await s.consume("u:1", "ai", 2, "day"), await s.consume("u:1", "ai", 2, "day"), await s.consume("u:1", "ai", 2, "day")];
  check("rpc: consume_usage counts down, -1 at the limit", r.join(",") === "1,0,-1", r.join(","));
  check("rpc: named arguments match the SQL function",
    calls[0].fn === "consume_usage" && JSON.stringify(calls[0].args) === JSON.stringify({ p_key: "u:1", p_bucket: "ai", p_limit: 2, p_window: "day" }));
  await s.refund("u:1", "ai", "day");
  check("rpc: refund_usage then usage_count", calls.at(-1)!.fn === "refund_usage" && (await s.count("u:1", "ai", "day")) === 1 && calls.at(-1)!.fn === "usage_count");
  await s.consume("u:1", "edit", Infinity, "day");
  check("rpc: unlimited is sent as Postgres int max", calls.at(-1)!.args.p_limit === 2_147_483_647);
  let threw = false;
  try { await supabaseUsageStore(fakeRpc(c.now, { fail: true }).client).consume("u:1", "ai", 1, "day"); } catch { threw = true; }
  check("rpc: database errors throw", threw);

  const memory = memoryUsageStore(c.now);
  const broken = withFallback(supabaseUsageStore(fakeRpc(c.now, { fail: true }).client), memory);
  const origError = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  const f = [await broken.consume("u:9", "ai", 1, "day"), await broken.consume("u:9", "ai", 1, "day")];
  console.error = origError;
  check("fallback: a failing database falls back to memory", f.join(",") === "0,-1" && (await memory.count("u:9", "ai", "day")) === 1, f.join(","));
  check("fallback: warns once, not per request", logged === 1, String(logged));
  const healthy = withFallback(s, memoryUsageStore(c.now));
  check("fallback: a healthy database is used", (await healthy.consume("u:1", "ai", 5, "day")) === 3);
}

// ---------- IP hashing ----------
{
  const SALT = "test-salt";
  const h = hashIp("203.0.113.9", SALT);
  check("ip: SHA-256 hex", /^[0-9a-f]{64}$/.test(h));
  check("ip: deterministic per salt", h === hashIp("203.0.113.9", SALT) && h !== hashIp("203.0.113.9", "other") && h !== hashIp("203.0.113.10", SALT));
  const req = new Request("http://x/", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
  const subject = usageSubject(req, null, SALT);
  check("ip: guest subject is ip:<hash> of the first forwarded address", subject === `ip:${h}` && !subject.includes("203.0.113"), subject);
  check("ip: x-real-ip when no x-forwarded-for", usageSubject(new Request("http://x/", { headers: { "x-real-ip": "203.0.113.9" } }), null, SALT) === `ip:${h}`);
  check("ip: account holders are keyed by user id", usageSubject(req, { id: "abc" }, SALT) === "u:abc");
  check("ip: IPv6 counted per /64", normalizeIp("2001:db8:1:2:aaaa::1") === "2001:db8:1:2::/64" && hashIp("2001:db8:1:2::5", SALT) === hashIp("2001:db8:1:2:ffff:1:2:3", SALT));
  check("ip: IPv4-mapped IPv6 and ports normalised", normalizeIp("::ffff:203.0.113.9") === "203.0.113.9" && normalizeIp("203.0.113.9:443") === "203.0.113.9");

  const env = process.env;
  const saved = { salt: env.USAGE_HASH_SALT, key: env.SUPABASE_SERVICE_ROLE_KEY, media: env.MEDIA_SIGNING_SECRET };
  env.USAGE_HASH_SALT = SALT;
  check("salt: USAGE_HASH_SALT is used", hashIp("203.0.113.9") === h);
  delete env.USAGE_HASH_SALT;
  delete env.MEDIA_SIGNING_SECRET;
  env.SUPABASE_SERVICE_ROLE_KEY = "service-key-1";
  const fromKey = hashIp("203.0.113.9");
  env.SUPABASE_SERVICE_ROLE_KEY = "service-key-2";
  check("salt: falls back to one derived from a server secret", fromKey !== hashIp("203.0.113.9") && fromKey !== h);
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const constant = hashIp("203.0.113.9");
  check("salt: else a constant, still never the raw IP", /^[0-9a-f]{64}$/.test(constant) && constant === hashIp("203.0.113.9"));
  for (const [k, v] of [["USAGE_HASH_SALT", saved.salt], ["SUPABASE_SERVICE_ROLE_KEY", saved.key], ["MEDIA_SIGNING_SECRET", saved.media]] as const) {
    if (v === undefined) delete env[k]; else env[k] = v;
  }
}

// ---------- AI policy ----------
{
  const p = (t: Tier, env = noEnv) => aiPolicy(t, env);
  check("ai policy: guest 3, free 10, pro 40, team 40 a day",
    p("guest").day === 3 && p("free").day === 10 && p("pro").day === 40 && p("team").day === 40);
  check("ai policy: monthly cap only on Pro (600)", p("pro").month === 600 && p("free").month === null && p("team").month === null && p("guest").month === null);
  check("ai policy: burst 6/min, site-wide 3000/day", p("free").burst === 6 && p("free").global === 3000);
  const env = { AI_LIMIT_PRO_DAY: "50", AI_LIMIT_PRO_MONTH: "0", AI_BURST_PER_MINUTE: "2", AI_GLOBAL_DAILY_LIMIT: "10", AI_GUEST_DAILY_LIMIT: "1" } as unknown as NodeJS.ProcessEnv;
  check("ai policy: env overrides", p("pro", env).day === 50 && p("pro", env).month === null && p("pro", env).burst === 2 && p("pro", env).global === 10 && p("guest", env).day === 1);
  check("ai policy: bad env values ignored", p("free", { AI_LIMIT_FREE_DAY: "lots" } as unknown as NodeJS.ProcessEnv).day === 10);
  check("ai policy: per-tier documents budgets kept", LIMITS.guest.aiDocumentChars < LIMITS.free.aiDocumentChars && LIMITS.free.aiDocumentChars < LIMITS.pro.aiDocumentChars);
}

// ---------- AI claims ----------
const claims = async (n: number, subject: string, tier: Tier, store: UsageStore, env = noEnv) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await claimAiAnswer(subject, tier, { store, env }));
  return out;
};
{
  const c = clock();
  const store = supabaseUsageStore(fakeRpc(c.now).client);
  const g = await claims(4, "ip:g", "guest", store);
  check("ai: guest gets 3, remaining 2,1,0", g.slice(0, 3).map((x) => (x.ok ? x.remaining : "x")).join(",") === "2,1,0");
  const fourth = g[3];
  check("ai: 4th guest answer refused with the upsell", !fourth.ok && fourth.status === 429 && fourth.upgrade === true && fourth.reason === "ai");
  check("ai: remaining without spending", (await aiRemaining("ip:g", "guest", { store, env: noEnv })) === 0 && (await aiRemaining("ip:new", "guest", { store, env: noEnv })) === 3);
  c.advance(DAY);
  check("ai: next UTC day the guest has 3 again", (await claimAiAnswer("ip:g", "guest", { store, env: noEnv })).ok);

  const f = [];
  for (let i = 0; i < 11; i++) {
    c.advance(MIN); // stay under the burst limit
    f.push(await claimAiAnswer("u:free", "free", { store, env: noEnv }));
  }
  check("ai: free gets 10 a day", f.filter((x) => x.ok).length === 10 && !f[10].ok);

  const off = await claimAiAnswer("ip:x", "guest", { store, env: { AI_GUEST_DAILY_LIMIT: "0" } as unknown as NodeJS.ProcessEnv });
  check("ai: AI_GUEST_DAILY_LIMIT=0 requires sign-in", !off.ok && off.status === 401 && /Sign in/.test(off.error));
}
{
  // Burst: 6 a minute, even with daily answers left.
  const c = clock();
  const store = memoryUsageStore(c.now);
  const r = await claims(7, "u:pro", "pro", store);
  const seventh = r[6];
  check("burst: 7th request in a minute refused", r.slice(0, 6).every((x) => x.ok) && !seventh.ok && seventh.status === 429 && seventh.error === AI_BURST_MESSAGE && !seventh.upgrade);
  check("burst: refused request leaves the day count alone", (await store.count("u:pro", "ai", "day")) === 6);
  c.advance(MIN);
  check("burst: next minute allowed again", (await claimAiAnswer("u:pro", "pro", { store, env: noEnv })).ok);
}
{
  // Pro: 40 a day and 600 a month.
  const c = clock(Date.UTC(2026, 9, 1, 0, 0, 0));
  const store = memoryUsageStore(c.now);
  let granted = 0;
  let lastRefusal = null as Awaited<ReturnType<typeof claimAiAnswer>> | null;
  for (let day = 0; day < 16; day++) {
    for (let i = 0; i < 41; i++) {
      if (i % 6 === 0) c.advance(MIN);
      const r = await claimAiAnswer("u:p", "pro", { store, env: noEnv });
      if (r.ok) granted++;
      else lastRefusal = r;
    }
    c.set(Date.UTC(2026, 9, 2 + day, 0, 0, 0));
  }
  check("month: pro stops at 600 in a month", granted === 600, String(granted));
  check("month: message says month, no upsell for Pro", !!lastRefusal && !lastRefusal.ok && /month/.test(lastRefusal.error) && lastRefusal.upgrade === false);
  check("month: refused month answer gives the day back", (await store.count("u:p", "ai", "day")) === 0);
  c.set(Date.UTC(2026, 10, 1, 0, 5, 0));
  check("month: next month allowed again", (await claimAiAnswer("u:p", "pro", { store, env: noEnv })).ok);
  // remaining = min(day, month)
  const s2 = memoryUsageStore(c.now);
  const first = await claimAiAnswer("u:q", "pro", { store: s2, env: { AI_LIMIT_PRO_MONTH: "5" } as unknown as NodeJS.ProcessEnv });
  check("month: remaining is the smaller of day and month", first.ok && first.remaining === 4);
  check("team: 40 a day per member, no month cap", aiPolicy("team", noEnv).day === 40 && aiPolicy("team", noEnv).month === null);
}
{
  // Site-wide cap.
  const c = clock();
  const store = memoryUsageStore(c.now);
  const env = { AI_GLOBAL_DAILY_LIMIT: "2" } as unknown as NodeJS.ProcessEnv;
  const a = await claimAiAnswer("u:a", "free", { store, env });
  const b = await claimAiAnswer("u:b", "free", { store, env });
  const busy = await claimAiAnswer("u:c", "pro", { store, env });
  check("global: third answer site-wide is refused as busy", a.ok && b.ok && !busy.ok && busy.status === 503 && busy.error === AI_BUSY_MESSAGE);
  check("global: busy message", AI_BUSY_MESSAGE === "The assistant is busy today. Try again tomorrow.");
  check("global: busy refusal doesn't cost the user", (await store.count("u:c", "ai", "day")) === 0 && (await store.count("u:c", "ai", "month")) === 0);
  // Refund: an answer that never arrived.
  if (a.ok) {
    await a.refund();
    await a.refund();
    check("refund: gives back the user's and the site's answer, once", (await store.count("u:a", "ai", "day")) === 0 && (await store.count("site", "ai", "day")) === 1);
  }
  check("global: after a refund, one more fits", (await claimAiAnswer("u:c", "pro", { store, env })).ok);
}

// ---------- daily allowances ----------
{
  const store = memoryUsageStore(clock().now);
  const r = [await consumeDaily("ip:z", "media", 2, store), await consumeDaily("ip:z", "media", 2, store), await consumeDaily("ip:z", "media", 2, store)];
  check("daily: media downloads count down then refuse", r.join(",") === "1,0,-1");
  check("daily: imports are a separate bucket", (await consumeDaily("ip:z", "slides", 2, store)) === 1);
}

// ---------- edits ----------
{
  const c = clock();
  for (const tier of ["guest", "free"] as const) {
    const store = supabaseUsageStore(fakeRpc(c.now).client);
    const s = `subject-${tier}`;
    const first = await claimEdit(s, tier, DOC_A, store);
    check(`edit (${tier}): first of the day allowed, marked`, first.allowed && first.remaining === 0 && first.watermark === true, JSON.stringify(first));
    const again = await claimEdit(s, tier, DOC_A, store);
    check(`edit (${tier}): same unchanged document again is free`, again.allowed && again.watermark === true);
    const second = await claimEdit(s, tier, DOC_B, store);
    check(`edit (${tier}): a second document is refused`, !second.allowed && second.remaining === 0);
    const retry = await claimEdit(s, tier, DOC_B, store);
    const stillA = await claimEdit(s, tier, DOC_A, store);
    check(`edit (${tier}): refusal is stable, first document still free`, !retry.allowed && stillA.allowed);
    c.advance(DAY);
    check(`edit (${tier}): next UTC day allowed again`, (await claimEdit(s, tier, DOC_C, store)).allowed);
    c.set(T0);
  }
  for (const tier of ["pro", "team"] as const) {
    const store = memoryUsageStore(c.now);
    const r = [];
    for (let i = 0; i < 25; i++) r.push(await claimEdit(`u:${tier}`, tier, i.toString(16).padStart(64, "0"), store));
    check(`edit (${tier}): unlimited, never marked`, r.every((x) => x.allowed && x.remaining === null && x.watermark === false));
  }
  // Concurrent first edits of two different documents: exactly one wins.
  const store = memoryUsageStore(c.now);
  const [x, y] = await Promise.all([claimEdit("ip:race", "guest", DOC_A, store), claimEdit("ip:race", "guest", DOC_B, store)]);
  check("edit: two documents at once, only one allowed", Number(x.allowed) + Number(y.allowed) === 1);
}

// ---------- watermark decision by tier ----------
check("watermark: guest and free marked, pro and team not",
  LIMITS.guest.watermark && LIMITS.free.watermark && !LIMITS.pro.watermark && !LIMITS.team.watermark);
check("edits: guest and free 1 a day, pro and team unlimited",
  LIMITS.guest.editsPerDay === 1 && LIMITS.free.editsPerDay === 1 && LIMITS.pro.editsPerDay === Infinity && LIMITS.team.editsPerDay === Infinity);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
