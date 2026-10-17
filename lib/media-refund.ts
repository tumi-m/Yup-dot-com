import { randomBytes } from "node:crypto";
import { periodStart, type UsageStore, type UsageWindow } from "./usage";

/**
 * A download is counted when /api/media/link grants it, and given back when
 * it verifiably failed, so a dead CDN or a broken worker never uses up a
 * visitor's day. Each grant carries who it was counted against (`s`), when
 * (`t`), and a random reference (`c`); a grant is refunded at most once.
 *
 * X: /api/media/file sees the failure itself (X refused the file, or the
 * stream broke). YouTube: the browser asks /api/media/refund, which voids
 * the grant at the worker (POST /refs/<c>/void) and refunds by what the
 * worker says became of it.
 */

export const MEDIA_BUCKET = "media";
const refundBucket = (ref: string) => `media-refund:${ref}`;
const servedBucket = (ref: string) => `media-served:${ref}`;
/**
 * Where the refunded/served markers are kept. They must outlive the grant
 * (30 minutes, and REFUND_GRACE_SECONDS more for a refund): in the daily
 * window they vanished at midnight, which brought a refunded grant back to
 * life and let a sent one be refunded.
 */
const MARKERS: UsageWindow = "month";

/** How long after a grant expires it can still be refunded (jobs may run 20 min). */
export const REFUND_GRACE_SECONDS = 2 * 60 * 60;

export interface GrantRef {
  /** Usage subject the download was counted against. */
  s: string;
  /** Random reference, one per grant. */
  c: string;
  /** When the grant was made (Unix seconds), taken just before it was counted. */
  t: number;
}

export function newGrantRef(): string {
  return randomBytes(12).toString("base64url");
}

export function grantRef(payload: Record<string, unknown> | null): GrantRef | null {
  if (!payload) return null;
  const { s, c, t } = payload;
  return typeof s === "string" && s && typeof c === "string" && /^[\w-]{8,64}$/.test(c) && typeof t === "number" && Number.isFinite(t)
    ? { s, c, t }
    : null;
}

/**
 * Gives the download back once per grant. True if this call refunded it.
 * Only on the UTC day the grant was counted: after midnight that day's
 * allowance is gone anyway, and taking one off today's would be a gift.
 */
export async function refundGrant(store: UsageStore, ref: GrantRef, now = Date.now()): Promise<boolean> {
  if (periodStart("day", ref.t * 1000) !== periodStart("day", now)) return false;
  if ((await store.consume(ref.s, refundBucket(ref.c), 1, MARKERS)) < 0) return false;
  await store.refund(ref.s, MEDIA_BUCKET, "day");
  return true;
}

/**
 * A refunded grant is dead: using it again would be a free download. A grant
 * from before this month can't be checked (its markers are gone), so it is
 * treated as dead too.
 */
export async function wasRefunded(store: UsageStore, ref: GrantRef, now = Date.now()): Promise<boolean> {
  if (ref.t * 1000 < periodStart("month", now)) return true;
  return (await store.count(ref.s, refundBucket(ref.c), MARKERS)) > 0;
}

/**
 * A grant that has sent a file is never refunded for a later failure:
 * otherwise a visitor could download the file, ask for it again with a Range
 * past its end, and the upstream error would give the download back.
 *
 * The two steps below run in opposite orders (serve: mark, then check for a
 * refund; refund: refund, then check for a serve), so two requests racing on
 * one grant can't both win: whichever looks second sees the other.
 */

/**
 * Call before sending a file. `ok` false: the grant was refunded meanwhile,
 * so don't send. `first`: no earlier request sent this grant's file.
 */
export async function startServing(store: UsageStore, ref: GrantRef, now = Date.now()): Promise<{ ok: boolean; first: boolean }> {
  const first = (await store.consume(ref.s, servedBucket(ref.c), 1, MARKERS)) >= 0;
  return { ok: !(await wasRefunded(store, ref, now)), first };
}

export async function wasServed(store: UsageStore, ref: GrantRef): Promise<boolean> {
  return (await store.count(ref.s, servedBucket(ref.c), MARKERS)) > 0;
}

/** Refunds a grant that never sent its file. True if this call refunded it. */
export async function refundUnserved(store: UsageStore, ref: GrantRef, now = Date.now()): Promise<boolean> {
  if (await wasServed(store, ref)) return false;
  if (!(await refundGrant(store, ref, now))) return false;
  if (await wasServed(store, ref)) {
    // Lost a race with a request that is sending the file: charge it again.
    await store.consume(ref.s, MEDIA_BUCKET, 2_147_483_647, "day");
    return false;
  }
  return true;
}

export type WorkerVerdict = "failed" | "unused" | "rejected" | "unreachable" | "used" | "unknown";

/**
 * Voids a grant at the worker, so it can no longer start a job, and returns
 * what the worker knows about it. "failed", "unused" and "rejected" allow a
 * refund: the visitor got no file.
 *
 * The worker keeps its record in memory, so it can only vouch for a grant
 * made after it started: one that restarted since (a redeploy, a crash, a
 * host waking from sleep) may have run the job and forgotten it. A worker
 * that doesn't answer may have run it too ("unreachable"). A worker too old
 * to void grants answers 404: "unknown", since the grant would still work
 * there. "rejected": the worker refuses our secret, so it refused the grant.
 */
export async function askWorker(
  workerUrl: string,
  secret: string,
  ref: GrantRef,
  fetcher: typeof fetch = fetch
): Promise<WorkerVerdict> {
  let res: Response;
  try {
    res = await fetcher(`${workerUrl}/refs/${encodeURIComponent(ref.c)}/void`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    return "unreachable";
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // A sleeping host's HTML page.
  if (!body) return "unreachable";
  if (res.status === 401) return "rejected";
  if (!res.ok || typeof body.used !== "boolean") return "unknown";
  if (body.used) return body.status === "error" ? "failed" : "used";
  return typeof body.since === "number" && body.since < ref.t ? "unused" : "unknown";
}

export const REFUNDABLE: readonly WorkerVerdict[] = ["failed", "unused", "rejected"];
