/**
 * Usage counters: daily / monthly / per-minute allowances for AI answers,
 * edits, media downloads and link imports.
 *
 * Production: one row per (subject, bucket, window, period) in Supabase,
 * incremented atomically by public.consume_usage() (supabase/schema.sql),
 * which only the service role may call. Counts survive cold starts and are
 * shared by every server instance.
 *
 * Without a service-role key (local dev, tests), or if the database call
 * fails, counts fall back to this process's memory: per instance, but never
 * a hard failure.
 *
 * Subjects: "u:<user id>" for accounts, "ip:<salted SHA-256>" for guests.
 * Raw IP addresses are never stored.
 */
import { createHash } from "node:crypto";
import { LIMITS, type Tier } from "./limits";

export type UsageWindow = "minute" | "day" | "month";

export interface UsageStore {
  /** Counts one use; returns uses left in the period, or -1 when the limit is reached (nothing counted). */
  consume(subject: string, bucket: string, limit: number, window: UsageWindow): Promise<number>;
  /** Gives back one use in the current period. */
  refund(subject: string, bucket: string, window: UsageWindow): Promise<void>;
  /** Uses so far in the current period. */
  count(subject: string, bucket: string, window: UsageWindow): Promise<number>;
}

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

/** Start of the current UTC period (matches date_trunc(window, now() at time zone 'utc')). */
export function periodStart(window: UsageWindow, now = Date.now()): number {
  const d = new Date(now);
  if (window === "minute") return Math.floor(now / 60_000) * 60_000;
  if (window === "day") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/* ------------------------------------------------------------------ */
/* In-memory store                                                     */
/* ------------------------------------------------------------------ */

export function memoryUsageStore(clock: () => number = Date.now): UsageStore {
  const counts = new Map<string, number>();
  let lastPrune = 0;
  const id = (s: string, b: string, w: UsageWindow) => `${w}|${periodStart(w, clock())}|${s}|${b}`;
  const prune = () => {
    const now = clock();
    if (now - lastPrune < 60_000) return;
    lastPrune = now;
    for (const k of counts.keys()) {
      const [w, start] = k.split("|");
      if (Number(start) !== periodStart(w as UsageWindow, now)) counts.delete(k);
    }
  };
  return {
    async consume(subject, bucket, limit, window) {
      prune();
      const k = id(subject, bucket, window);
      const used = counts.get(k) ?? 0;
      if (used >= limit) return -1;
      counts.set(k, used + 1);
      return limit - used - 1;
    },
    async refund(subject, bucket, window) {
      const k = id(subject, bucket, window);
      const used = counts.get(k) ?? 0;
      if (used > 1) counts.set(k, used - 1);
      else counts.delete(k);
    },
    async count(subject, bucket, window) {
      return counts.get(id(subject, bucket, window)) ?? 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Supabase store                                                      */
/* ------------------------------------------------------------------ */

/** The part of a supabase-js client this module uses. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

/** Postgres int max: an "unlimited" allowance still has to fit the column. */
const MAX_LIMIT = 2_147_483_647;

export function supabaseUsageStore(client: RpcClient): UsageStore {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message ?? "database error"}`);
    return Number(data);
  };
  return {
    async consume(subject, bucket, limit, window) {
      const n = await call("consume_usage", {
        p_key: subject,
        p_bucket: bucket,
        p_limit: Math.max(0, Math.min(MAX_LIMIT, Math.floor(limit))),
        p_window: window,
      });
      if (!Number.isFinite(n)) throw new Error("consume_usage: bad result");
      return n;
    },
    async refund(subject, bucket, window) {
      await call("refund_usage", { p_key: subject, p_bucket: bucket, p_window: window });
    },
    async count(subject, bucket, window) {
      const n = await call("usage_count", { p_key: subject, p_bucket: bucket, p_window: window });
      return Number.isFinite(n) ? n : 0;
    },
  };
}

/** Uses `primary`, and the memory store whenever a call to it fails. */
export function withFallback(primary: UsageStore, fallback: UsageStore): UsageStore {
  let warned = false;
  const guard = async <T>(run: (s: UsageStore) => Promise<T>): Promise<T> => {
    try {
      return await run(primary);
    } catch (err) {
      if (!warned) {
        warned = true;
        console.error(
          "Usage counters unavailable, counting in memory. Run supabase/migrations/20261005000000_usage_counters.sql.",
          err instanceof Error ? err.message : err
        );
      }
      return run(fallback);
    }
  };
  return {
    consume: (s, b, l, w) => guard((st) => st.consume(s, b, l, w)),
    refund: (s, b, w) => guard((st) => st.refund(s, b, w)),
    count: (s, b, w) => guard((st) => st.count(s, b, w)),
  };
}

const memory = memoryUsageStore();
let store: UsageStore | null = null;

function createDefaultStore(): UsageStore {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return memory;
  try {
    // Lazily, so the service key never reaches a client bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@supabase/supabase-js");
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    return withFallback(supabaseUsageStore(admin), memory);
  } catch (err) {
    console.error("Usage counters: Supabase client unavailable.", err instanceof Error ? err.message : err);
    return memory;
  }
}

export function usageStore(): UsageStore {
  return (store ??= createDefaultStore());
}

/** Tests: replace the store (null restores the default). */
export function setUsageStore(next: UsageStore | null) {
  store = next;
}

/* ------------------------------------------------------------------ */
/* Subjects                                                            */
/* ------------------------------------------------------------------ */

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

function ipSalt(env: NodeJS.ProcessEnv = process.env): string {
  if (env.USAGE_HASH_SALT) return env.USAGE_HASH_SALT;
  // A secret the deployment already has, so the hash can't be reversed by
  // hashing every IPv4 address with a public constant.
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.MEDIA_SIGNING_SECRET || "";
  return createHash("sha256").update(`pdf-wizard/usage-ip/v1|${secret}`).digest("hex");
}

/**
 * IPv6 clients usually own a whole /64, so count the prefix, not the address.
 * IPv4 (including IPv4-mapped IPv6) is used as is.
 */
export function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]") > 0 ? s.indexOf("]") : undefined);
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return mapped[1];
  if (!s.includes(":") || /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) return s.replace(/:\d+$/, "");
  const [head, tail = ""] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = s.includes("::") && tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

export function hashIp(ip: string, salt = ipSalt()): string {
  return createHash("sha256").update(`${salt}|${normalizeIp(ip)}`).digest("hex");
}

/** Who a request counts against: the account, or the guest's hashed IP. */
export function usageSubject(request: Request, user: { id: string } | null, salt?: string): string {
  return user ? `u:${user.id}` : `ip:${hashIp(clientIp(request), salt)}`;
}

/* ------------------------------------------------------------------ */
/* AI answers                                                          */
/* ------------------------------------------------------------------ */

export interface AiPolicy {
  /** Answers per UTC day; 0 means none (a guest must sign in). */
  day: number;
  /** Answers per UTC month, or null for no monthly cap. */
  month: number | null;
  /** Requests per minute. */
  burst: number;
  /** Answers per day across the whole site. */
  global: number;
}

const AI_MONTH_DEFAULT: Record<Tier, number | null> = { guest: null, free: null, pro: 600, team: null };

function envInt(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/**
 * AI allowances. Every number can be overridden: AI_LIMIT_<TIER>_DAY,
 * AI_LIMIT_<TIER>_MONTH (0 = no monthly cap), AI_BURST_PER_MINUTE,
 * AI_GLOBAL_DAILY_LIMIT. AI_GUEST_DAILY_LIMIT (older name) still sets the
 * guest allowance; 0 requires an account.
 */
export function aiPolicy(tier: Tier, env: NodeJS.ProcessEnv = process.env): AiPolicy {
  const T = tier.toUpperCase();
  const day =
    envInt(env, `AI_LIMIT_${T}_DAY`) ??
    (tier === "guest" ? envInt(env, "AI_GUEST_DAILY_LIMIT") : undefined) ??
    LIMITS[tier].aiAnswersPerDay;
  const monthEnv = envInt(env, `AI_LIMIT_${T}_MONTH`);
  const month = monthEnv === undefined ? AI_MONTH_DEFAULT[tier] : monthEnv === 0 ? null : monthEnv;
  return {
    day,
    month,
    burst: Math.max(1, envInt(env, "AI_BURST_PER_MINUTE") ?? 6),
    global: envInt(env, "AI_GLOBAL_DAILY_LIMIT") ?? 3000,
  };
}

export const AI_BUSY_MESSAGE = "The assistant is busy today. Try again tomorrow.";
export const AI_BURST_MESSAGE = "Too many questions at once. Try again in a minute.";
const GLOBAL_SUBJECT = "site";

export type AiClaim =
  | { ok: true; remaining: number; refund: () => Promise<void> }
  | { ok: false; status: number; error: string; upgrade?: boolean; reason?: string };

/**
 * Claims one AI answer: the caller's day (and month), then the per-minute
 * burst, then the site-wide day. A refused claim leaves every count as it
 * was (the burst counts only answers that passed the daily check); `refund`
 * gives the answer back when none was delivered.
 */
export async function claimAiAnswer(subject: string, tier: Tier, opts: { env?: NodeJS.ProcessEnv; store?: UsageStore } = {}): Promise<AiClaim> {
  const s = opts.store ?? usageStore();
  const policy = aiPolicy(tier, opts.env);
  const upgrade = tier !== "pro" && tier !== "team";
  const spent = { ok: false as const, status: 429, error: "You've used today's AI answers.", upgrade, reason: "ai" };
  if (policy.day <= 0) {
    return tier === "guest" ? { ok: false, status: 401, error: "Sign in to use the AI assistant." } : spent;
  }

  const taken: UsageWindow[] = [];
  const giveBack = async () => {
    for (const w of taken) await s.refund(subject, "ai", w);
  };

  const day = await s.consume(subject, "ai", policy.day, "day");
  if (day < 0) return spent;
  taken.push("day");

  let month: number | null = null;
  if (policy.month !== null) {
    month = await s.consume(subject, "ai", policy.month, "month");
    if (month < 0) {
      await giveBack();
      return { ok: false, status: 429, error: "You've used this month's AI answers.", upgrade, reason: "ai" };
    }
    taken.push("month");
  }

  if ((await s.consume(subject, "ai", policy.burst, "minute")) < 0) {
    await giveBack();
    return { ok: false, status: 429, error: AI_BURST_MESSAGE, reason: "burst" };
  }
  taken.push("minute");

  if ((await s.consume(GLOBAL_SUBJECT, "ai", policy.global, "day")) < 0) {
    await giveBack();
    return { ok: false, status: 503, error: AI_BUSY_MESSAGE, reason: "busy" };
  }

  let refunded = false;
  return {
    ok: true,
    remaining: month === null ? day : Math.min(day, month),
    refund: async () => {
      if (refunded) return;
      refunded = true;
      await giveBack();
      await s.refund(GLOBAL_SUBJECT, "ai", "day");
    },
  };
}

/** Answers left today (and this month, when capped) without spending one. */
export async function aiRemaining(subject: string, tier: Tier, opts: { env?: NodeJS.ProcessEnv; store?: UsageStore } = {}): Promise<number> {
  const s = opts.store ?? usageStore();
  const policy = aiPolicy(tier, opts.env);
  let left = Math.max(0, policy.day - (await s.count(subject, "ai", "day")));
  if (policy.month !== null) left = Math.min(left, Math.max(0, policy.month - (await s.count(subject, "ai", "month"))));
  return left;
}

/* ------------------------------------------------------------------ */
/* Daily allowances (media downloads, link imports)                    */
/* ------------------------------------------------------------------ */

/** Spends one of today's `bucket` allowance; uses left, or -1 when spent. */
export function consumeDaily(subject: string, bucket: string, limit: number, store: UsageStore = usageStore()): Promise<number> {
  return store.consume(subject, bucket, limit, "day");
}

/* ------------------------------------------------------------------ */
/* Edits (Edit PDF, Sign PDF, Edit PPTX)                               */
/* ------------------------------------------------------------------ */

export interface EditClaim {
  allowed: boolean;
  /** Edits left today; null when unlimited. */
  remaining: number | null;
  /** Whether files from this edit carry the "Made with PDF Wizard" mark. */
  watermark: boolean;
}

export function isDocFingerprint(doc: unknown): doc is string {
  return typeof doc === "string" && /^[0-9a-f]{64}$/.test(doc);
}

/**
 * One edit = one distinct document (by content fingerprint) saved out per
 * day. The same unchanged document again the same day is free.
 */
export async function claimEdit(subject: string, tier: Tier, doc: string, store: UsageStore = usageStore()): Promise<EditClaim> {
  const { editsPerDay, watermark } = LIMITS[tier];
  if (!Number.isFinite(editsPerDay)) return { allowed: true, remaining: null, watermark };

  const docBucket = `edit-doc:${doc}`;
  if ((await store.consume(subject, docBucket, 1, "day")) < 0) {
    // Already paid for today.
    const used = await store.count(subject, "edit", "day");
    return { allowed: true, remaining: Math.max(0, editsPerDay - used), watermark };
  }
  const left = await store.consume(subject, "edit", editsPerDay, "day");
  if (left < 0) {
    await store.refund(subject, docBucket, "day");
    return { allowed: false, remaining: 0, watermark };
  }
  return { allowed: true, remaining: left, watermark };
}
