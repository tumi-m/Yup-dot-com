import { randomBytes } from "node:crypto";
import type { UsageStore } from "./usage";

/**
 * A download is counted when /api/media/link grants it, and given back when
 * it verifiably failed, so a dead CDN or a broken worker never uses up a
 * visitor's day. Each grant carries who it was counted against (`s`) and a
 * random reference (`c`); a grant is refunded at most once.
 *
 * X: /api/media/file sees the failure itself (X refused the file, or the
 * stream broke). YouTube: the browser asks /api/media/refund, which checks
 * with the worker's record of the grant (GET /refs/<c>) before refunding.
 */

export const MEDIA_BUCKET = "media";
const refundBucket = (ref: string) => `media-refund:${ref}`;

/** How long after a grant expires it can still be refunded (jobs may run 20 min). */
export const REFUND_GRACE_SECONDS = 2 * 60 * 60;

export interface GrantRef {
  /** Usage subject the download was counted against. */
  s: string;
  /** Random reference, one per grant. */
  c: string;
}

export function newGrantRef(): string {
  return randomBytes(12).toString("base64url");
}

export function grantRef(payload: Record<string, unknown> | null): GrantRef | null {
  if (!payload) return null;
  const { s, c } = payload;
  return typeof s === "string" && s && typeof c === "string" && /^[\w-]{8,64}$/.test(c) ? { s, c } : null;
}

/** Gives the download back once per grant. True if this call refunded it. */
export async function refundGrant(store: UsageStore, ref: GrantRef): Promise<boolean> {
  if ((await store.consume(ref.s, refundBucket(ref.c), 1, "day")) < 0) return false;
  await store.refund(ref.s, MEDIA_BUCKET, "day");
  return true;
}

/** A refunded grant is dead: using it again would be a free download. */
export async function wasRefunded(store: UsageStore, ref: GrantRef): Promise<boolean> {
  return (await store.count(ref.s, refundBucket(ref.c), "day")) > 0;
}

export type WorkerVerdict = "failed" | "unused" | "unreachable" | "used" | "unknown";

/**
 * What the worker knows about a grant. "failed", "unused" and "unreachable"
 * allow a refund: the visitor got no file. ("unreachable": a worker that
 * can't answer can't have just served one either.)
 */
export async function askWorker(
  workerUrl: string,
  secret: string,
  ref: string,
  fetcher: typeof fetch = fetch
): Promise<WorkerVerdict> {
  let res: Response;
  try {
    res = await fetcher(`${workerUrl}/refs/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    return "unreachable";
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // A sleeping host's HTML page, or a worker that rejects our secret (so it
  // rejected the grant too): no job ran.
  if (!body || res.status === 401) return "unreachable";
  if (res.status === 404) return body.used === false ? "unused" : "unknown";
  if (res.ok && body.used === true) return body.status === "error" ? "failed" : "used";
  return "unknown";
}

export const REFUNDABLE: readonly WorkerVerdict[] = ["failed", "unused", "unreachable"];
