/**
 * Local-currency prices: country → currency, the ?currency= override,
 * conversion and rounding, formatting, the live FX fetch with its cache, and
 * the fallback table when the fetch fails. No network: fetch is faked.
 */
import {
  buildPriceDisplay, convertFromZar, currencyForCountry, displayPrice, fractionDigitsFor,
  resolveDisplayCurrency, FALLBACK_RATES, COUNTRY_CURRENCY,
} from "../lib/currency.ts";
import { zarRates, resetFxCache, FX_URL, FX_TTL_MS } from "../lib/fx.ts";
import { PLANS, PRICE_AMOUNTS } from "../lib/plans.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};
const NBSP = " ";

// ---------- country → currency ----------
check("ZA → ZAR", currencyForCountry("ZA") === "ZAR");
check("missing header (local dev) → ZAR", currencyForCountry(null) === "ZAR" && currencyForCountry("") === "ZAR" && currencyForCountry(undefined) === "ZAR");
check("lowercase / padded codes accepted", currencyForCountry(" ng ") === "NGN");
check("main markets", currencyForCountry("US") === "USD" && currencyForCountry("GB") === "GBP" && currencyForCountry("DE") === "EUR" &&
  currencyForCountry("FR") === "EUR" && currencyForCountry("KE") === "KES" && currencyForCountry("NA") === "NAD" &&
  currencyForCountry("IN") === "INR" && currencyForCountry("AU") === "AUD" && currencyForCountry("BW") === "BWP");
check("unknown country → USD", currencyForCountry("AQ") === "USD" && currencyForCountry("XX") === "USD");
check("garbage header → ZAR default", currencyForCountry("Z1") === "ZAR" && currencyForCountry("ZAF") === "ZAR");
check("every mapped currency has a fallback rate",
  Object.values(COUNTRY_CURRENCY).every((c) => FALLBACK_RATES[c] > 0), Object.values(COUNTRY_CURRENCY).filter((c) => !FALLBACK_RATES[c]).join());

// ---------- override ----------
check("?currency=eur overrides the country", JSON.stringify(resolveDisplayCurrency({ country: "ZA", override: "eur" })) === '{"country":"ZA","currency":"EUR"}');
check("?currency=ZAR from abroad shows rand", resolveDisplayCurrency({ country: "US", override: "ZAR" }).currency === "ZAR");
check("unknown or malformed override ignored",
  resolveDisplayCurrency({ country: "GB", override: "XYZ" }).currency === "GBP" &&
  resolveDisplayCurrency({ country: "GB", override: "<script>" }).currency === "GBP" &&
  resolveDisplayCurrency({ country: "GB", override: "" }).currency === "GBP");
check("no header + no override → ZA/ZAR", JSON.stringify(resolveDisplayCurrency({})) === '{"country":"ZA","currency":"ZAR"}');

// ---------- conversion & formatting ----------
{
  const za = buildPriceDisplay({ country: "ZA", currency: "ZAR", rate: 1, source: "live", amounts: PRICE_AMOUNTS });
  check("South Africa: exact rand, no conversion", za.local && za.amounts["49"] === "R49" && za.amounts["199"] === "R199" &&
    za.amounts["1990"] === `R1${NBSP}990` && za.amounts["0"] === "R0" && za.source === "zar", JSON.stringify(za.amounts));
  check("PRICE_AMOUNTS covers monthly and prepaid prices", JSON.stringify([...PRICE_AMOUNTS].sort((a, b) => a - b)) === "[0,49,199,490,1990]");

  const us = buildPriceDisplay({ country: "US", currency: "USD", rate: 0.056, source: "live", amounts: PRICE_AMOUNTS });
  check("USD: two decimals", !us.local && us.amounts["49"] === "$2.74" && us.amounts["199"] === "$11.14" && us.amounts["490"] === "$27.44",
    JSON.stringify(us.amounts));
  check("USD: same precision for the yearly price", us.amounts["1990"] === "$111.44", us.amounts["1990"]);
  check("free stays a whole zero", us.amounts["0"] === "$0");

  const ng = buildPriceDisplay({ country: "NG", currency: "NGN", rate: 85, source: "live", amounts: PRICE_AMOUNTS });
  check("NGN: whole naira", ng.amounts["49"] === "₦4,165" && ng.amounts["199"] === "₦16,915", JSON.stringify(ng.amounts));
  const jp = buildPriceDisplay({ country: "JP", currency: "JPY", rate: 8.3, source: "live", amounts: [49] });
  check("JPY: no decimals", jp.amounts["49"] === "¥407", jp.amounts["49"]);
  const ie = buildPriceDisplay({ country: "ZA", currency: "EUR", rate: 0.049, source: "live", amounts: [49, 199] });
  check("EUR override from ZA formats as euro, not en-ZA", ie.amounts["49"] === "€2.40" && ie.amounts["199"] === "€9.75", JSON.stringify(ie.amounts));
  const gb = buildPriceDisplay({ country: "GB", currency: "GBP", rate: 0.042, source: "live", amounts: [49] });
  check("GBP", gb.amounts["49"] === "£2.06", gb.amounts["49"]);
  const ke = buildPriceDisplay({ country: "KE", currency: "KES", rate: 7.2, source: "live", amounts: [49] });
  check("KES: whole shillings", /^Ksh\s?353$/.test(ke.amounts["49"]), ke.amounts["49"]);
  check("rounding is to the displayed precision", convertFromZar(49, 0.0545, 2) === 2.67 && convertFromZar(49, 85, 0) === 4165);
  check("precision rule: ≥100 for the cheapest plan → whole units", fractionDigitsFor("USD", 0.056) === 2 && fractionDigitsFor("INR", 4.8) === 0 && fractionDigitsFor("JPY", 0.5) === 0);

  const fb = buildPriceDisplay({ country: "US", currency: "USD", rate: undefined, source: "live", amounts: [49] });
  check("missing live rate → fallback table", fb.source === "fallback" && fb.amounts["49"] === `$${(Math.round(49 * FALLBACK_RATES.USD * 100) / 100).toFixed(2)}`, JSON.stringify(fb));
  const bad = buildPriceDisplay({ country: "US", currency: "USD", rate: NaN, source: "live", amounts: [49] });
  check("NaN rate → fallback table", bad.source === "fallback");
  const unknown = buildPriceDisplay({ country: "XX", currency: "QQQ", rate: undefined, source: "live", amounts: [49] });
  check("currency with no rate at all → USD", unknown.currency === "USD");
  check("displayPrice falls back to rand", displayPrice(null, 49) === "R49" && displayPrice(us, 49) === "$2.74" && displayPrice(us, 7) === "R7");
}

// ---------- live FX fetch, cache, fallback ----------
{
  let calls = 0;
  let mode: "ok" | "500" | "throw" | "bad" = "ok";
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (String(url) !== FX_URL) throw new Error("unexpected url " + url);
    const next = (init as { next?: { revalidate?: number } } | undefined)?.next;
    if (next?.revalidate !== FX_TTL_MS / 1000) throw new Error("no revalidate");
    if (mode === "throw") throw new Error("offline");
    if (mode === "500") return new Response("oops", { status: 500 });
    if (mode === "bad") return new Response(JSON.stringify({ result: "success", base_code: "USD", rates: { USD: 1 } }));
    return new Response(JSON.stringify({ result: "success", base_code: "ZAR", rates: { ZAR: 1, USD: 0.0571, EUR: 0.0499, NGN: 88.1, XXX: "x" } }));
  }) as typeof fetch;
  let now = 1_800_000_000_000;
  const opts = { fetch: fake, now: () => now };

  resetFxCache();
  const live = await zarRates(opts);
  check("live rates parsed (12h revalidate requested)", live.source === "live" && live.rates.USD === 0.0571 && live.rates.NGN === 88.1 && calls === 1);
  check("non-numeric rates dropped, table fills gaps", !("XXX" in live.rates) && live.rates.JPY === FALLBACK_RATES.JPY);
  await zarRates(opts);
  check("cached in memory within 12h", calls === 1);
  now += FX_TTL_MS + 1;
  mode = "500";
  const failed = await zarRates(opts);
  check("HTTP error → fallback table", failed.source === "fallback" && failed.rates.USD === FALLBACK_RATES.USD && calls === 2);
  await zarRates(opts);
  check("fallback is not retried immediately", calls === 2);
  now += 11 * 60 * 1000;
  mode = "throw";
  check("network error → fallback", (await zarRates(opts)).source === "fallback" && calls === 3);
  now += 11 * 60 * 1000;
  mode = "bad";
  check("wrong base currency → fallback", (await zarRates(opts)).source === "fallback" && calls === 4);
  now += 11 * 60 * 1000;
  mode = "ok";
  check("recovers to live after the retry window", (await zarRates(opts)).source === "live" && calls === 5);
  resetFxCache();
}

// ---------- plan copy ----------
check("Free card copy", JSON.stringify(PLANS.free.features) === JSON.stringify(["Every tool", "1 edit a day", "50 MB files, 10 at a time", "Video up to 720p"]));
check("Pro leads with unlimited edits, no watermark", PLANS.pro.features[0] === "Unlimited edits, no watermark");
check("Team: Everything in Pro + 5 seats", JSON.stringify(PLANS.team.features) === JSON.stringify(["Everything in Pro", "5 seats"]));
check("no plan promises 'No watermark' on Free", !PLANS.free.features.some((f) => /watermark/i.test(f)));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
