/**
 * The Google Analytics wrapper (lib/analytics.ts): consent storage, Consent
 * Mode commands, and that nothing is sent without a measurement ID or
 * without consent.
 */
import { runInNewContext } from "node:vm";

process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "g-test123";

// A browser-ish global for the runtime part; set before the module loads.
const dataLayer: unknown[] = [];
const win: Record<string, unknown> = { dataLayer };
win.gtag = function () {
  // eslint-disable-next-line prefer-rest-params
  dataLayer.push(arguments);
};
Object.assign(globalThis, { window: win, location: { pathname: "/tools/merge-pdf", hostname: "localhost" } });

const A = await import("../lib/analytics.ts");

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}
const entries = () => dataLayer.map((a) => Array.from(a as ArrayLike<unknown>));
const events = (name: string) => entries().filter((a) => a[0] === "event" && a[1] === name);

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const throwing = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

// ---------- Measurement ID ----------
check("measurement ID read from env, upper-cased", A.GA_ID === "G-TEST123", A.GA_ID);
check("valid ID accepted", A.validGaId("G-ABC12345") === "G-ABC12345");
check("unset ID → null", A.validGaId(undefined) === null && A.validGaId("") === null);
check("Universal Analytics ID rejected", A.validGaId("UA-12345-1") === null);
check("script injection rejected", A.validGaId("G-1');alert(1)//") === null);

// ---------- Stored consent ----------
{
  const s = memoryStore();
  check("no stored choice → null", A.readConsent(s) === null);
  check("save → true", A.saveConsent("granted", s, new Date("2026-10-10T10:00:00Z")));
  check("read back granted", A.readConsent(s) === "granted");
  const rec = JSON.parse(s.m.get(A.CONSENT_KEY)!);
  check("record keeps version and time", rec.v === A.CONSENT_VERSION && rec.at === "2026-10-10T10:00:00.000Z", rec);
  A.saveConsent("denied", s);
  check("read back denied", A.readConsent(s) === "denied");
  check("blocked storage: read → null", A.readConsent(throwing) === null);
  check("blocked storage: save → false, no throw", A.saveConsent("granted", throwing) === false);
  check("no storage: save → false", A.saveConsent("granted", null) === false);
  check("old version asks again", A.parseConsent(JSON.stringify({ v: 0, choice: "granted", at: "2026-01-01T00:00:00Z" })) === null);
  check("unknown choice ignored", A.parseConsent(JSON.stringify({ v: 1, choice: "maybe", at: "2026-01-01T00:00:00Z" })) === null);
  check("bad date ignored", A.parseConsent(JSON.stringify({ v: 1, choice: "granted", at: "soon" })) === null);
  check("garbage ignored", A.parseConsent("{not json") === null && A.parseConsent("null") === null);
}

// ---------- Consent Mode commands ----------
{
  const keys = ["ad_personalization", "ad_storage", "ad_user_data", "analytics_storage"];
  check("defaults deny all four v2 keys", keys.every((k) => (A.CONSENT_DEFAULTS as Record<string, string>)[k] === "denied") && Object.keys(A.CONSENT_DEFAULTS).sort().join() === keys.join());
  check("update only touches analytics_storage", JSON.stringify(A.consentUpdate("granted")) === '{"analytics_storage":"granted"}');
  // Run the <head> snippet in a fresh context, as the browser would.
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  runInNewContext(A.consentBootstrapScript(), sandbox);
  const layer = (sandbox.dataLayer as ArrayLike<unknown>[]).map((a) => Array.from(a));
  check("bootstrap: first entry is consent default", layer[0][0] === "consent" && layer[0][1] === "default", layer[0]);
  check("bootstrap: default denies everything", keys.every((k) => (layer[0][2] as Record<string, string>)[k] === "denied"));
  check("bootstrap: entries are Arguments objects, as gtag.js expects", Object.prototype.toString.call((sandbox.dataLayer as unknown[])[0]) === "[object Arguments]");
  check("bootstrap: defines window.gtag", typeof sandbox.gtag === "function");
  check("bootstrap: no config, no gtag.js", !layer.some((a) => a[0] === "config" || a[0] === "js"));
}

// ---------- shouldTrack ----------
check("no ID → never", !A.shouldTrack(null, "granted", true));
check("no consent → never", !A.shouldTrack("G-X1234", null, true) && !A.shouldTrack("G-X1234", "denied", true));
check("no gtag → never", !A.shouldTrack("G-X1234", "granted", false));
check("ID + consent + gtag → yes", A.shouldTrack("G-X1234", "granted", true));

// ---------- Runtime: no-op until consent ----------
check("track before consent → false", A.track("tool_used", { tool: "merge-pdf" }) === false);
check("trackToolUsed before consent → false", A.trackToolUsed() === false);
check("nothing queued before consent", dataLayer.length === 0, entries());
check("applyConsent without an ID → false, nothing queued", A.applyConsent("granted", null) === false && dataLayer.length === 0);

check("applyConsent(granted) → load gtag.js", A.applyConsent("granted") === true);
{
  const e = entries();
  check("granted: update then js then config", e[0][0] === "consent" && e[0][1] === "update" && e[1][0] === "js" && e[2][0] === "config" && e[2][1] === "G-TEST123", e.map((a) => a.slice(0, 2)));
  check("granted: Google signals off", (e[2][2] as Record<string, unknown>).allow_google_signals === false);
  check("granted: ga-disable cleared", win["ga-disable-G-TEST123"] === false);
}
A.applyConsent("granted");
check("config sent once per page load", entries().filter((a) => a[0] === "config").length === 1);

check("trackToolUsed after consent → true", A.trackToolUsed() === true);
check("tool slug taken from the path", (events("tool_used")[0]?.[2] as Record<string, unknown>)?.tool === "merge-pdf", events("tool_used"));
A.trackDownload("Quarterly Report (final).PDF");
{
  const p = events("file_download")[0]?.[2] as Record<string, unknown>;
  check("file_download: extension only, lower-case", p?.file_extension === "pdf" && !JSON.stringify(p).includes("Quarterly"), p);
  check("file_download: tool from the path", p?.tool === "merge-pdf");
}
check("no page_view is ever sent by hand", events("page_view").length === 0);

// begin_checkout / purchase
{
  const sub = A.checkoutParams({ plan: "pro", mode: "subscription" });
  check("pro monthly: R49 in ZAR", sub.currency === "ZAR" && sub.value === 49 && sub.items[0].item_id === "pro_monthly" && sub.items[0].price === 49, sub);
  const year = A.checkoutParams({ plan: "team", mode: "once", months: 12 });
  check("team 1 year: R1990 (ten months)", year.value === 1990 && year.items[0].item_id === "team_12m", year);
  check("pro 1 month: R49", A.checkoutParams({ plan: "pro", mode: "once", months: 1 }).value === 49);
  A.trackBeginCheckout({ plan: "team", mode: "subscription" });
  const bc = events("begin_checkout")[0]?.[2] as Record<string, unknown>;
  check("begin_checkout sent with value and currency", bc?.value === 199 && bc?.currency === "ZAR", bc);

  const s = memoryStore();
  check("purchase sent", A.trackPurchase("pw_aaaaaaaaaaaaaaaaaaaaaaaa", { plan: "pro", mode: "subscription" }, 49, s) === true);
  const pu = events("purchase")[0]?.[2] as Record<string, unknown>;
  check("purchase carries the reference, value and ZAR", pu?.transaction_id === "pw_aaaaaaaaaaaaaaaaaaaaaaaa" && pu?.value === 49 && pu?.currency === "ZAR", pu);
  check("same reference not sent twice (this visit)", A.trackPurchase("pw_aaaaaaaaaaaaaaaaaaaaaaaa", { plan: "pro", mode: "subscription" }, 49, s) === false);
  check("same reference not sent twice (stored, new visit)", A.sentPurchases(s).includes("pw_aaaaaaaaaaaaaaaaaaaaaaaa"));
  const s2 = memoryStore();
  s2.setItem("pdfw-ga-purchases", JSON.stringify(["pw_bbbbbbbbbbbbbbbbbbbbbbbb"]));
  check("reference already stored → skipped", A.trackPurchase("pw_bbbbbbbbbbbbbbbbbbbbbbbb", { plan: "pro", mode: "subscription" }, 49, s2) === false);
  check("charged amount overrides the list price", A.trackPurchase("pw_cccccccccccccccccccccccc", { plan: "pro", mode: "once", months: 12 }, 490, s2) && (events("purchase").pop()?.[2] as Record<string, unknown>).value === 490);
  check("purchase works with blocked storage", A.trackPurchase("pw_dddddddddddddddddddddddd", { plan: "pro", mode: "subscription" }, 49, throwing) === true);
  check("three distinct purchases sent", events("purchase").length === 3, events("purchase").length);
}

// Withdrawal: back to no-op.
check("applyConsent(denied) → no gtag.js", A.applyConsent("denied") === false);
check("denied: ga-disable set", win["ga-disable-G-TEST123"] === true);
check("denied: update queued", (entries().filter((a) => a[0] === "consent").pop()?.[2] as Record<string, string>).analytics_storage === "denied");
const before = dataLayer.length;
check("track after withdrawal → false", A.track("tool_used", { tool: "x" }) === false && dataLayer.length === before);

// Helpers
check("cleanParams drops undefined, caps at 100 chars", JSON.stringify(A.cleanParams({ a: undefined, b: "x".repeat(150), c: 3 })) === JSON.stringify({ b: "x".repeat(100), c: 3 }));
check("fileExtension", A.fileExtension("a.b.DOCX") === "docx" && A.fileExtension("noext") === undefined && A.fileExtension("weird.toolongextension") === undefined);
check("toolFromPath", A.toolFromPath("/tools/pdf-to-word") === "pdf-to-word" && A.toolFromPath("/edit/abc") === "edit-pdf" && A.toolFromPath("/editor/abc") === "edit-pdf" && A.toolFromPath("/pricing") === undefined);

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
