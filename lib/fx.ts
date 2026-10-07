/**
 * Exchange rates from the rand, for showing estimated local prices. Live
 * rates come from open.er-api.com (free, no key, covers African currencies),
 * cached for 12 hours by Next's data cache and in memory. If the fetch fails
 * the built-in table in lib/currency.ts is used. `fetch` and the clock are
 * injectable for tests.
 */
import { FALLBACK_RATES } from "./currency";

export const FX_URL = "https://open.er-api.com/v6/latest/ZAR";
export const FX_TTL_MS = 12 * 60 * 60 * 1000;
/** After a failed fetch, try again sooner. */
const RETRY_MS = 10 * 60 * 1000;

export interface ZarRates {
  rates: Record<string, number>;
  source: "live" | "fallback";
}

let memo: { value: ZarRates; until: number } | null = null;

export function resetFxCache() {
  memo = null;
}

export async function zarRates(
  opts: { fetch?: typeof fetch; now?: () => number } = {}
): Promise<ZarRates> {
  const now = opts.now?.() ?? Date.now();
  if (memo && memo.until > now) return memo.value;

  const f = opts.fetch ?? globalThis.fetch;
  try {
    const res = await f(FX_URL, {
      // Next's data cache: one request per 12h per deployment.
      next: { revalidate: FX_TTL_MS / 1000 },
      signal: AbortSignal.timeout(4000),
    } as RequestInit);
    if (!res.ok) throw new Error(`FX ${res.status}`);
    const body = (await res.json()) as { result?: string; base_code?: string; rates?: Record<string, unknown> };
    if (body.result !== "success" || body.base_code !== "ZAR" || !body.rates) throw new Error("FX: bad payload");
    const rates: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.rates)) {
      if (/^[A-Z]{3}$/.test(k) && typeof v === "number" && v > 0 && Number.isFinite(v)) rates[k] = v;
    }
    if (!rates.USD) throw new Error("FX: no USD");
    const value: ZarRates = { rates: { ...FALLBACK_RATES, ...rates }, source: "live" };
    memo = { value, until: now + FX_TTL_MS };
    return value;
  } catch {
    const value: ZarRates = { rates: { ...FALLBACK_RATES }, source: "fallback" };
    memo = { value, until: now + RETRY_MS };
    return value;
  }
}
