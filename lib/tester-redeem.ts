/**
 * POST /api/access/redeem: a signed-in user redeems a tester code (or, with
 * `check: true`, asks what it would give, without using it). Server only.
 *
 * Every check is in the database (redeem_tester_code in supabase/schema.sql,
 * callable only with the service role): unknown, revoked, expired and
 * used-up codes, one redemption per person per code, and max_uses under
 * concurrent redemptions. Here: sign-in, cross-site requests, the body's
 * shape, and a limit on tries per account and per IP address. Every answer
 * after the limit takes at least MIN_ANSWER_MS, and an unknown code and a
 * revoked one get the same answer from the same query, so neither the
 * message nor the timing tells them apart.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { refuseCrossSite } from "./cross-site";
import {
  REDEEM_ERRORS,
  REDEEM_TOO_MANY,
  REDEEM_UNAVAILABLE,
  TESTER_CODE_MAX_INPUT,
  isTesterCode,
  normalizeTesterCode,
  parseRedeemResult,
  type RedeemError,
} from "./tester-access";
import type { UsageWindow } from "./usage";

/** SHA-256 (hex) of the code's canonical form: what public.access_codes stores. */
export function hashTesterCode(code: string): string {
  return createHash("sha256").update(normalizeTesterCode(code)).digest("hex");
}

/** Tries a day: per account, and per IP address (offices and families share one). */
export const REDEEM_LIMITS = { user: 20, ip: 50 } as const;
export const REDEEM_BUCKET = "tester-code";
/** The shortest time any answer to a try takes. */
export const MIN_ANSWER_MS = 400;

const DB_ERRORS: Record<string, RedeemError> = {
  invalid_code: "invalid",
  code_expired: "expired",
  code_used_up: "used-up",
  already_redeemed: "already-redeemed",
};

/** The database's refusal (P0001 and one of its four reasons), or null for anything else. */
export function redeemErrorOf(error: { code?: string; message?: string } | null | undefined): RedeemError | null {
  if (!error || error.code !== "P0001") return null;
  return DB_ERRORS[(error.message ?? "").trim()] ?? null;
}

export interface RedeemDeps {
  /** The signed-in user, or null. */
  getUser: () => Promise<{ id: string } | null>;
  /** Calls public.redeem_tester_code with the service role (supabase-js rpc result). */
  redeem: (args: { uid: string; code: string; dry_run: boolean }) => PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
  /** lib/usage.ts consume: uses left, or -1 when the limit is reached. */
  consume: (subject: string, bucket: string, limit: number, window: UsageWindow) => Promise<number>;
  /** Who the request counts against by address (lib/usage.ts usageSubject with no user). */
  ipSubject: (request: Request) => string;
  /** Tests: no waiting. */
  minAnswerMs?: number;
}

let bodySchema: z.ZodType<{ code: string; check: boolean }, z.ZodTypeDef, unknown> | null = null;
function schema() {
  return (bodySchema ??= z.object({
    code: z.string().max(TESTER_CODE_MAX_INPUT),
    check: z.boolean().optional().default(false),
  }));
}

const headers = { "Cache-Control": "no-store" };
const answer = (body: unknown, status = 200) => Response.json(body, { status, headers });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleRedeem(request: Request, deps: RedeemDeps): Promise<Response> {
  const refused = refuseCrossSite(request);
  if (refused) return refused;

  const user = await deps.getUser();
  if (!user) return answer({ error: "Sign in first." }, 401);

  const parsed = schema().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return answer({ error: "Enter your tester code." }, 400);
  const { code, check } = parsed.data;

  // Every try counts, a malformed code too: the address first, so many
  // accounts behind one address can't try without limit.
  try {
    if ((await deps.consume(deps.ipSubject(request), REDEEM_BUCKET, REDEEM_LIMITS.ip, "day")) < 0 ||
        (await deps.consume(`u:${user.id}`, REDEEM_BUCKET, REDEEM_LIMITS.user, "day")) < 0) {
      return answer({ error: REDEEM_TOO_MANY, reason: "rate-limited" }, 429);
    }
  } catch (err) {
    console.error("tester code limit unavailable", err instanceof Error ? err.message : err);
    return answer({ error: REDEEM_UNAVAILABLE }, 503);
  }

  const started = Date.now();
  let status = 200;
  let body: Record<string, unknown>;
  if (!isTesterCode(code)) {
    status = 400;
    body = { error: REDEEM_ERRORS.invalid, reason: "invalid" };
  } else {
    try {
      const { data, error } = await deps.redeem({ uid: user.id, code: normalizeTesterCode(code), dry_run: check });
      const refusal = redeemErrorOf(error);
      const result = error ? null : parseRedeemResult(data);
      if (refusal) {
        status = 400;
        body = { error: REDEEM_ERRORS[refusal], reason: refusal };
      } else if (result) {
        body = { plan: result.plan, until: result.until, days: result.days, ...(check ? { check: true } : {}) };
      } else {
        // Never the database's words: they could say more than the four answers do.
        console.error("redeem_tester_code failed", error?.code ?? "", error?.message ?? "bad result");
        status = 503;
        body = { error: REDEEM_UNAVAILABLE };
      }
    } catch (err) {
      console.error("redeem_tester_code failed", err instanceof Error ? err.message : err);
      status = 503;
      body = { error: REDEEM_UNAVAILABLE };
    }
  }
  const wait = (deps.minAnswerMs ?? MIN_ANSWER_MS) - (Date.now() - started);
  if (wait > 0) await sleep(wait);
  return answer(body, status);
}
