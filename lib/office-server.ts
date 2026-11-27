/**
 * Word and Excel to PDF on the server: /api/convert/link signs one upload to
 * the media worker, and /api/convert/refund gives a conversion back when the
 * worker says it failed or never ran.
 *
 * As the media routes: other sites' pages are refused, the plan's file size
 * and daily allowance are checked here and spent before the link is made
 * (with a per-minute limit on asking), and a grant records who it was
 * counted against, when, and a random reference the worker keeps
 * (lib/media-refund.ts). The token names the file's size and type, lasts two
 * minutes and starts one conversion; it is signed with a key of its own, so
 * a download grant can't pass for a conversion grant or be refunded as one.
 * The file's name never leaves the browser.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { refuseCrossSite } from "./cross-site";
import { formatLimitBytes, limitsFor, type Tier } from "./limits";
import { signToken, verifyToken, WORKER_CONFIG_HELP, workerConfig } from "./media-server";
import { askWorker, grantRef, newGrantRef, REFUND_GRACE_SECONDS, REFUNDABLE, refundGrant } from "./media-refund";
import { DEFAULT_SHEET_OPTIONS, OFFICE_FORMATS, officeExtension, officeTypeProblem } from "./office";
import { claimOfficeLink, consumeDaily, OFFICE_BURST_MESSAGE, usageStore, usageSubject, type UsageStore } from "./usage";

export const OFFICE_BUCKET = "office";
/** How long an upload grant lasts: the browser starts uploading at once. */
export const OFFICE_TOKEN_TTL = 120;
export const OFFICE_OFF_MESSAGE = "Word and Excel to PDF isn't switched on for this site yet.";

/** Read where it's used, not at build time, so tests can switch it. */
export function officeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NEXT_PUBLIC_ENABLE_OFFICE_CONVERT === "1";
}

/** The conversion grants' key, derived from the shared secret (media-worker/office.py derives the same). */
export function officeKey(secret: string): string {
  return createHmac("sha256", secret).update("pdf-wizard/office-token/v1").digest("base64url");
}

export interface OfficeDeps {
  resolveTier: () => Promise<{ user: { id: string } | null; tier: Tier }>;
  /** Tests: a usage store, an environment and a worker of their own. */
  store?: UsageStore;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long a refund waits for a cancelled conversion to stop. */
  settleMs?: number;
}

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const linkSchema = z.object({
  tool: z.enum(["word-to-pdf", "excel-to-pdf"]),
  name: z.string().min(1).max(1000),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  options: z
    .object({
      fit: z.boolean(),
      orientation: z.enum(["auto", "portrait", "landscape"]),
      sheets: z.enum(["all", "first"]),
    })
    .partial()
    .optional(),
});

export async function handleOfficeLink(request: Request, deps: OfficeDeps): Promise<Response> {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const env = deps.env ?? process.env;
  if (!officeEnabled(env)) return json(503, { error: OFFICE_OFF_MESSAGE });
  const config = workerConfig(env);
  if (!config.ok) {
    console.error(`Word and Excel to PDF disabled: ${WORKER_CONFIG_HELP[config.reason]}`);
    return json(503, { error: OFFICE_OFF_MESSAGE });
  }
  const parsed = linkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json(400, { error: "Invalid request." });
  const { tool, name, size } = parsed.data;
  const problem = officeTypeProblem(tool, name);
  if (problem) return json(415, { error: problem });
  if (size === 0) return json(422, { error: "This file is empty." });

  const { user, tier } = await deps.resolveTier();
  const store = deps.store ?? usageStore();
  const subject = usageSubject(request, user, undefined, env);
  // Every ask counts toward the minute, granted or not.
  if (!(await claimOfficeLink(subject, store))) {
    return json(429, { error: OFFICE_BURST_MESSAGE, reason: "burst" }, { "Retry-After": "60" });
  }
  const limits = limitsFor(tier);
  const paid = tier === "pro" || tier === "team";
  if (size > limits.officeMaxBytes) {
    return json(413, { error: `Files up to ${formatLimitBytes(limits.officeMaxBytes)} on your plan.`, upgrade: !paid, reason: "size" });
  }
  const made = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  // Spent here, so a race at the limit is still refused.
  const remaining = await consumeDaily(subject, OFFICE_BUCKET, limits.officeConversionsPerDay, store);
  if (remaining < 0) {
    return json(429, {
      error: paid ? "You've used today's conversions." : "You've used today's free conversions.",
      upgrade: !paid,
      reason: "quota",
    });
  }
  const ext = officeExtension(name)!;
  const options = tool === "excel-to-pdf" ? { ...DEFAULT_SHEET_OPTIONS, ...parsed.data.options } : {};
  const token = signToken(
    { k: "office", x: ext, z: size, o: options, s: subject, c: newGrantRef(), t: made },
    officeKey(config.secret),
    OFFICE_TOKEN_TTL
  );
  return json(200, { workerUrl: config.url, token, remaining, formats: OFFICE_FORMATS[tool] });
}

const refundSchema = z.object({ token: z.string().min(10).max(4000) });

/**
 * Gives a conversion back when the worker says it failed (a file it turned
 * away, a timeout, the browser cancelling) or never started. The worker's
 * record decides, so a PDF that was sent is never refunded, and a refunded
 * grant can't start a conversion afterwards.
 */
export async function handleOfficeRefund(request: Request, deps: OfficeDeps): Promise<Response> {
  const refused = refuseCrossSite(request);
  if (refused) return refused;
  const env = deps.env ?? process.env;
  const parsed = refundSchema.safeParse(await request.json().catch(() => null));
  const config = workerConfig(env);
  if (!parsed.success || !config.ok) return json(400, { refunded: false });
  const payload = verifyToken(parsed.data.token, officeKey(config.secret), REFUND_GRACE_SECONDS);
  const ref = payload?.k === "office" ? grantRef(payload) : null;
  if (!ref) return json(400, { refunded: false });
  const verdict = await askWorker(config.url, config.secret, ref, deps.fetch ?? fetch, deps.settleMs ?? 4000);
  if (!REFUNDABLE.includes(verdict)) return json(409, { refunded: false });
  const now = deps.now?.() ?? Date.now();
  return json(200, { refunded: await refundGrant(deps.store ?? usageStore(), ref, now, OFFICE_BUCKET) });
}
