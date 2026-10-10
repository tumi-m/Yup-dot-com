/**
 * Google Analytics 4 with Consent Mode v2, in "basic" mode: gtag.js is not
 * loaded at all until the visitor accepts analytics cookies. Every helper
 * here is a no-op without a measurement ID or without consent.
 *
 * Page views: gtag's `config` sends the first one, and GA4's enhanced
 * measurement ("Page changes based on browser history events", on by
 * default) sends one for every client-side navigation. Nothing here sends
 * page_view by hand, so each navigation is counted once.
 */
import { CURRENCY, PLANS, prepaidPrice, type PaidPlanId, type PrepaidMonths } from "./plans";

/** A GA4 measurement ID ("G-XXXXXXXXXX"), or null. Anything else is ignored. */
export function validGaId(value: string | undefined | null): string | null {
  const v = (value ?? "").trim().toUpperCase();
  return /^G-[A-Z0-9]{4,20}$/.test(v) ? v : null;
}

export const GA_ID = validGaId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID);

// ---------- Consent ----------

export type ConsentChoice = "granted" | "denied";

export const CONSENT_KEY = "pdfw-consent";
/** Bump to ask everyone again (say, after adding a new kind of cookie). */
export const CONSENT_VERSION = 1;
/** Footer "Cookie settings" dispatches this on window to reopen the banner. */
export const OPEN_CONSENT_EVENT = "pdfw:cookie-settings";

export interface StoredConsent {
  v: number;
  choice: ConsentChoice;
  /** When the choice was made (ISO). Kept as the record of consent. */
  at: string;
}

export function parseConsent(raw: string | null | undefined): StoredConsent | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<StoredConsent> | null;
    if (!c || c.v !== CONSENT_VERSION) return null;
    if (c.choice !== "granted" && c.choice !== "denied") return null;
    if (typeof c.at !== "string" || Number.isNaN(Date.parse(c.at))) return null;
    return { v: c.v, choice: c.choice, at: c.at };
  } catch {
    return null;
  }
}

export function serializeConsent(choice: ConsentChoice, now: Date = new Date()): string {
  return JSON.stringify({ v: CONSENT_VERSION, choice, at: now.toISOString() } satisfies StoredConsent);
}

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // blocked storage throws on access
  }
}

/** The saved choice, or null when there is none (or storage is unavailable). */
export function readConsent(store: Store | null = browserStore()): ConsentChoice | null {
  try {
    return parseConsent(store?.getItem(CONSENT_KEY))?.choice ?? null;
  } catch {
    return null;
  }
}

/** Saves the choice. False when storage is unavailable (the choice then lasts this visit). */
export function saveConsent(choice: ConsentChoice, store: Store | null = browserStore(), now = new Date()): boolean {
  try {
    if (!store) return false;
    store.setItem(CONSENT_KEY, serializeConsent(choice, now));
    return true;
  } catch {
    return false;
  }
}

/** Consent Mode v2 defaults: everything denied until the visitor says yes. */
export const CONSENT_DEFAULTS = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
} as const;

/** The site shows no ads, so only analytics_storage ever changes. */
export function consentUpdate(choice: ConsentChoice) {
  return { analytics_storage: choice } as const;
}

/**
 * Runs in <head> before anything else: defines dataLayer and gtag and sets
 * the denied defaults. gtag.js itself loads only after consent.
 */
export function consentBootstrapScript(): string {
  return [
    "window.dataLayer=window.dataLayer||[];",
    "function gtag(){dataLayer.push(arguments);}",
    "window.gtag=gtag;",
    `gtag('consent','default',${JSON.stringify(CONSENT_DEFAULTS)});`,
    "gtag('set','ads_data_redaction',true);",
  ].join("");
}

/** Settings for `gtag('config', id, …)`: no Google signals, no ad personalisation. */
export const GA_CONFIG = {
  allow_google_signals: false,
  allow_ad_personalization_signals: false,
} as const;

// ---------- Runtime state (browser) ----------

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

let consent: ConsentChoice | null = null;
let configured = false;

/** Whether an event would be sent right now. Pure, for tests. */
export function shouldTrack(gaId: string | null, choice: ConsentChoice | null, hasGtag: boolean): boolean {
  return !!gaId && choice === "granted" && hasGtag;
}

function gtag(...args: unknown[]) {
  if (typeof window === "undefined") return;
  if (!window.gtag) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      // gtag.js reads Arguments objects, not arrays.
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
    };
  }
  window.gtag(...args);
}

/**
 * Applies a choice: tells gtag, flips GA's own opt-out switch, and on
 * "granted" configures the tag (once per page load). Returns true when
 * gtag.js should be loaded.
 */
export function applyConsent(choice: ConsentChoice, gaId: string | null = GA_ID): boolean {
  if (!gaId || typeof window === "undefined") return false;
  consent = choice;
  (window as unknown as Record<string, unknown>)[`ga-disable-${gaId}`] = choice !== "granted";
  gtag("consent", "update", consentUpdate(choice));
  if (choice !== "granted") return false;
  if (!configured) {
    configured = true;
    gtag("js", new Date());
    gtag("config", gaId, GA_CONFIG);
  }
  return true;
}

/** Deletes GA's cookies (_ga, _ga_<id>) on this host and its parent domains. */
export function clearGaCookies(): void {
  if (typeof document === "undefined") return;
  const names = document.cookie
    .split(";")
    .map((c) => c.split("=")[0].trim())
    .filter((n) => /^_ga(_|$)|^_gid$|^_gat/.test(n));
  if (!names.length) return;
  const parts = location.hostname.split(".");
  const domains = [""];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`; domain=.${parts.slice(i).join(".")}`);
  for (const name of names) {
    for (const d of domains) document.cookie = `${name}=; Max-Age=0; path=/${d}`;
  }
}

// ---------- Events ----------

export type EventParams = Record<string, string | number | boolean | EventItem[] | undefined>;

export interface EventItem {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
}

/** GA caps parameter values at 100 characters; drops undefined values. */
export function cleanParams(params: EventParams = {}): EventParams {
  const out: EventParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? v.slice(0, 100) : v;
  }
  return out;
}

/** Sends a GA4 event. A no-op without a measurement ID or consent. */
export function track(name: string, params?: EventParams): boolean {
  const hasGtag = typeof window !== "undefined" && typeof window.gtag === "function";
  if (!shouldTrack(GA_ID, consent, hasGtag)) return false;
  gtag("event", name, cleanParams(params));
  return true;
}

export type CheckoutChoice =
  | { plan: PaidPlanId; mode: "subscription" }
  | { plan: PaidPlanId; mode: "once"; months: PrepaidMonths };

/** begin_checkout / purchase parameters for a plan choice, in rand. */
export function checkoutParams(c: CheckoutChoice): { currency: string; value: number; items: EventItem[] } {
  const value = c.mode === "once" ? prepaidPrice(c.plan, c.months) : PLANS[c.plan].priceMonthly;
  const term = c.mode === "once" ? (c.months === 12 ? "1 year" : "1 month") : "monthly";
  return {
    currency: CURRENCY,
    value,
    items: [
      {
        item_id: `${c.plan}_${c.mode === "once" ? `${c.months}m` : "monthly"}`,
        item_name: `${PLANS[c.plan].name} (${term})`,
        price: value,
        quantity: 1,
      },
    ],
  };
}

export function trackBeginCheckout(c: CheckoutChoice): boolean {
  return track("begin_checkout", checkoutParams(c));
}

const PURCHASES_KEY = "pdfw-ga-purchases";

/** References already reported, newest last (a short list). */
export function sentPurchases(store: Store | null = browserStore()): string[] {
  try {
    const list = JSON.parse(store?.getItem(PURCHASES_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

const reportedThisVisit = new Set<string>();

/**
 * purchase, once per Paystack reference: remembered for this visit and in
 * localStorage, and GA itself also drops repeats of a transaction_id.
 */
export function trackPurchase(
  reference: string,
  c: CheckoutChoice,
  /** Rand actually charged, when known; otherwise the plan's price. */
  amount?: number,
  store: Store | null = browserStore()
): boolean {
  if (reportedThisVisit.has(reference) || sentPurchases(store).includes(reference)) return false;
  const params = checkoutParams(c);
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
    params.value = amount;
    params.items[0].price = amount;
  }
  if (!track("purchase", { transaction_id: reference, ...params })) return false;
  reportedThisVisit.add(reference);
  try {
    store?.setItem(PURCHASES_KEY, JSON.stringify([...sentPurchases(store), reference].slice(-20)));
  } catch {
    // storage full or blocked: this visit's memory still prevents a repeat
  }
  return true;
}

/** "Report.Final.PDF" → "pdf". Never the file name itself, which may be personal. */
export function fileExtension(name: string): string | undefined {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : undefined;
}

/** The tool a page belongs to: /tools/merge-pdf → "merge-pdf"; the editors → "edit-pdf". */
export function toolFromPath(pathname: string): string | undefined {
  const tool = /^\/tools\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (tool) return tool[1];
  if (/^\/(edit|editor)\//.test(pathname)) return "edit-pdf";
  return undefined;
}

export function trackToolUsed(tool: string): boolean {
  return track("tool_used", { tool });
}

/** Our downloads are blob: links, which enhanced measurement can't see. */
export function trackDownload(filename: string, tool?: string): boolean {
  const where = tool ?? (typeof location !== "undefined" ? toolFromPath(location.pathname) : undefined);
  return track("file_download", { file_extension: fileExtension(filename), tool: where });
}
