/**
 * Showing prices in the visitor's currency. Paystack charges in rand only, so
 * these are estimates for orientation: every converted price is shown with
 * the rand amount actually billed. Pure functions — safe on server and client,
 * and testable without a network.
 */
import { CURRENCY, formatPrice } from "./plans";

/** Country (ISO 3166-1 alpha-2) → currency (ISO 4217). Unknown → USD. */
export const COUNTRY_CURRENCY: Record<string, string> = {
  // Southern Africa
  ZA: "ZAR", NA: "NAD", LS: "LSL", SZ: "SZL", BW: "BWP", ZW: "USD", ZM: "ZMW", MZ: "MZN", MW: "MWK", AO: "AOA",
  // Rest of Africa
  NG: "NGN", GH: "GHS", KE: "KES", UG: "UGX", TZ: "TZS", RW: "RWF", ET: "ETB", EG: "EGP", MA: "MAD", TN: "TND",
  CI: "XOF", SN: "XOF", CM: "XAF", MU: "MUR",
  // Europe (IE first: it is the euro's display locale below)
  IE: "EUR", DE: "EUR", FR: "EUR", NL: "EUR", BE: "EUR", ES: "EUR", IT: "EUR", PT: "EUR", AT: "EUR", FI: "EUR",
  GR: "EUR", LU: "EUR", SK: "EUR", SI: "EUR", EE: "EUR", LV: "EUR", LT: "EUR", CY: "EUR", MT: "EUR", HR: "EUR",
  GB: "GBP", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", TR: "TRY",
  // Americas
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN",
  // Middle East & Asia-Pacific
  AE: "AED", SA: "SAR", IL: "ILS", QA: "QAR", IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", CN: "CNY", HK: "HKD",
  TW: "TWD", JP: "JPY", KR: "KRW", SG: "SGD", MY: "MYR", TH: "THB", ID: "IDR", PH: "PHP", VN: "VND",
  AU: "AUD", NZ: "NZD",
};

export const DEFAULT_COUNTRY = "ZA";
const FALLBACK_CURRENCY = "USD";

/**
 * Units of each currency per 1 ZAR, used when live rates can't be fetched.
 * Approximate; refresh occasionally. NAD, LSL and SZL are pegged 1:1.
 */
export const FALLBACK_RATES: Record<string, number> = {
  ZAR: 1, NAD: 1, LSL: 1, SZL: 1, BWP: 0.76, ZMW: 1.45, MZN: 3.6, MWK: 98, AOA: 51,
  NGN: 85, GHS: 0.62, KES: 7.2, UGX: 205, TZS: 150, RWF: 80, ETB: 7.8, EGP: 2.75, MAD: 0.52, TND: 0.17,
  XOF: 32, XAF: 32, MUR: 2.55,
  EUR: 0.049, GBP: 0.042, CHF: 0.046, SEK: 0.54, NOK: 0.58, DKK: 0.37, PLN: 0.21, CZK: 1.24, HUF: 20,
  RON: 0.25, TRY: 2.2,
  USD: 0.056, CAD: 0.077, MXN: 1.05, BRL: 0.31, ARS: 65, CLP: 53, COP: 225, PEN: 0.21,
  AED: 0.206, SAR: 0.21, ILS: 0.21, QAR: 0.204, INR: 4.8, PKR: 15.8, BDT: 6.8, LKR: 16.8, CNY: 0.4, HKD: 0.44,
  TWD: 1.8, JPY: 8.3, KRW: 77, SGD: 0.073, MYR: 0.24, THB: 1.85, IDR: 910, PHP: 3.2, VND: 1450,
  AUD: 0.086, NZD: 0.095,
};

const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

export function currencyForCountry(country: string | null | undefined): string {
  const c = country?.trim().toUpperCase();
  if (!c || !COUNTRY_RE.test(c)) return CURRENCY; // no geo header (local dev): South Africa
  return COUNTRY_CURRENCY[c] ?? FALLBACK_CURRENCY;
}

/**
 * The currency to show: a valid `?currency=` override, else the visitor's
 * country's. Overrides are limited to currencies we have a rate for.
 */
export function resolveDisplayCurrency(input: {
  country?: string | null;
  override?: string | null;
}): { country: string; currency: string } {
  const raw = input.country?.trim().toUpperCase();
  const country = raw && COUNTRY_RE.test(raw) ? raw : DEFAULT_COUNTRY;
  const o = input.override?.trim().toUpperCase();
  if (o && CURRENCY_RE.test(o) && o in FALLBACK_RATES) return { country, currency: o };
  return { country, currency: currencyForCountry(raw) };
}

/** A locale that formats `currency` naturally for this visitor. */
export function localeFor(country: string, currency: string): string {
  const home = COUNTRY_CURRENCY[country] === currency
    ? country
    : Object.keys(COUNTRY_CURRENCY).find((k) => COUNTRY_CURRENCY[k] === currency) ?? "US";
  const locale = `en-${home}`;
  try {
    return Intl.NumberFormat.supportedLocalesOf([locale]).length ? locale : "en";
  } catch {
    return "en";
  }
}

/**
 * Decimal places for a currency at a given rate: whole units when even the
 * cheapest plan comes to 100 or more (₦4,165, not ₦4,165.00), otherwise cents.
 * Never more than the currency itself uses (JPY has none).
 */
export function fractionDigitsFor(currency: string, rate: number, cheapest = 49): number {
  let native = 2;
  try {
    native = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // unknown code: keep 2
  }
  return cheapest * rate >= 100 ? 0 : Math.min(2, native);
}

/** Converts rand and rounds to the currency's display precision. */
export function convertFromZar(rand: number, rate: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(rand * rate * f) / f;
}

export function formatMoney(amount: number, currency: string, locale: string, digits: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: amount === 0 ? 0 : digits,
    maximumFractionDigits: amount === 0 ? 0 : digits,
  }).format(amount);
}

/**
 * Prices as display strings, keyed by the rand amount. Built on the server
 * and handed to client components as plain strings, so server and browser
 * render identical text whatever their Intl data.
 */
export interface PriceDisplay {
  country: string;
  currency: string;
  /** True when showing rand: no conversion, no "Billed as" note. */
  local: boolean;
  source: "zar" | "live" | "fallback";
  amounts: Record<string, string>;
}

export function buildPriceDisplay(input: {
  country: string;
  currency: string;
  rate: number | null | undefined;
  source: "live" | "fallback";
  amounts: number[];
}): PriceDisplay {
  let { currency } = input;
  let rate = input.rate;
  let source: PriceDisplay["source"] = input.source;
  if (currency !== CURRENCY && !(typeof rate === "number" && rate > 0 && Number.isFinite(rate))) {
    rate = FALLBACK_RATES[currency];
    source = "fallback";
    if (!rate) {
      currency = FALLBACK_CURRENCY;
      rate = FALLBACK_RATES[FALLBACK_CURRENCY];
    }
  }
  if (currency === CURRENCY) {
    return {
      country: input.country,
      currency,
      local: true,
      source: "zar",
      amounts: Object.fromEntries(input.amounts.map((a) => [String(a), formatPrice(a)])),
    };
  }
  const locale = localeFor(input.country, currency);
  const digits = fractionDigitsFor(currency, rate!);
  return {
    country: input.country,
    currency,
    local: false,
    source,
    amounts: Object.fromEntries(
      input.amounts.map((a) => [String(a), formatMoney(convertFromZar(a, rate!, digits), currency, locale, digits)])
    ),
  };
}

/** The display string for a rand amount; rand when no display is available. */
export function displayPrice(display: PriceDisplay | null | undefined, rand: number): string {
  return display?.amounts[String(rand)] ?? formatPrice(rand);
}
