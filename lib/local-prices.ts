import { headers } from "next/headers";
import { buildPriceDisplay, resolveDisplayCurrency, type PriceDisplay } from "@/lib/currency";
import { CURRENCY, PRICE_AMOUNTS } from "@/lib/plans";
import { zarRates } from "@/lib/fx";

/**
 * Prices for this visitor: country from Vercel's geo header (absent in local
 * dev, which means South Africa), or a `?currency=XXX` override. Server-only.
 */
export async function getPriceDisplay(override?: string | null): Promise<PriceDisplay> {
  const country = (await headers()).get("x-vercel-ip-country");
  const target = resolveDisplayCurrency({ country, override });
  if (target.currency === CURRENCY) {
    return buildPriceDisplay({ ...target, rate: 1, source: "live", amounts: PRICE_AMOUNTS });
  }
  const fx = await zarRates();
  return buildPriceDisplay({ ...target, rate: fx.rates[target.currency], source: fx.source, amounts: PRICE_AMOUNTS });
}
