/**
 * In-memory daily counters, keyed by user id or guest IP. Per server instance,
 * so this is a cost backstop and an upgrade moment, not exact billing.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const buckets = new Map<string, number[]>();

/** Records one use; returns uses remaining, or -1 if the allowance is spent. */
export function consumeDaily(key: string, limit: number): number {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < DAY_MS);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return -1;
  }
  recent.push(now);
  buckets.set(key, recent);
  return limit - recent.length;
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
