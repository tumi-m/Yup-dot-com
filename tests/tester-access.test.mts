// Tester codes: how a code is read (any case and spacing), what is stored
// for it (the same SHA-256 the database computes), and how /redeem takes the
// code out of its link: the fragment goes into this tab's sessionStorage and
// leaves the address bar before anything else runs, so it can't reach server
// logs, referrers or analytics.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {
  REDEEM_ERRORS,
  REDEEM_FRAGMENT_SCRIPT,
  TESTER_CODE_ALPHABET,
  TESTER_CODE_EVENT,
  TESTER_CODE_KEY,
  forgetTesterCode,
  formatTesterCode,
  coveredMessage,
  isTesterCode,
  lastTesterTime,
  normalizeTesterCode,
  parseRedeemResult,
  parseTesterAccess,
  takeTesterCode,
  testerActive,
  testerLabel,
  testerPlan,
  testerTimes,
  type CodeWindow,
} from "../lib/tester-access.ts";
import { hashTesterCode } from "../lib/tester-redeem.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------- Codes ----------
check("the alphabet: 32 symbols, no 0, O, 1 or I", TESTER_CODE_ALPHABET.length === 32 && !/[01OI]/.test(TESTER_CODE_ALPHABET) &&
  new Set(TESTER_CODE_ALPHABET).size === 32);
check("16 symbols of 5 bits: 80 random bits", 16 * Math.log2(TESTER_CODE_ALPHABET.length) >= 80);
check("typed loosely, read the same", normalizeTesterCode(" k7qm 8xrp-2d4n\tw9hc ") === "K7QM8XRP2D4NW9HC");
check("formatted in groups of four", formatTesterCode("k7qm8xrp2d4nw9hc") === "K7QM-8XRP-2D4N-W9HC");
check("a pasted code with dots and dashes", formatTesterCode("K7QM.8XRP.2D4N.W9HC.") === "K7QM-8XRP-2D4N-W9HC");
for (const [what, raw] of [
  ["too short", "K7QM-8XRP-2D4N"],
  ["too long", "K7QM-8XRP-2D4N-W9HC-AAAA"],
  ["an O (not in the alphabet)", "K7QM-8XRP-2D4N-W9HO"],
  ["a 1", "K7QM-8XRP-2D4N-W9H1"],
  ["empty", ""],
  ["not text", 42],
  ["huge input", "A".repeat(10_000)],
] as const) {
  check(`not a code: ${what}`, !isTesterCode(raw) && formatTesterCode(raw) === null);
}
// The database stores SHA-256 of the canonical code; tests/rls/rls.test.sql
// checks tester_code_hash() gives this same value.
const VECTOR = "f598056127fcd4387651a49b3a4235d8ce50d71f4091068df51511cfc10f388f";
check("hash: SHA-256 of the canonical code", hashTesterCode("ABCDEFGHJKMNPQRS") === VECTOR);
check("hash: however it was typed", hashTesterCode("abcd efgh-jkmn pqrs") === VECTOR);
check("the RLS tests check the database's hash against the same value", read("tests/rls/rls.test.sql").includes(VECTOR));

// The database reads codes by the same rules.
const schema = read("supabase/schema.sql");
const migration = read("supabase/migrations/20261019000000_tester_access.sql");
check("database: same normalising rule", schema.includes("upper(regexp_replace(coalesce(code, ''), '[^0-9A-Za-z]', '', 'g'))"));
check("database: same code shape", schema.includes("v_norm !~ '^[2-9A-HJ-NP-Z]{16}$'"));
check("database: same alphabet", schema.includes(`alphabet constant text := '${TESTER_CODE_ALPHABET}'`));
check("database: 80 random bits per code", /gen_random_bytes\(10\)/.test(schema) && /bit\(80\)/.test(schema));
check("database: the link puts the code after #", schema.includes("v_site || '/redeem#' || v_code") &&
  schema.includes("'https://pdfwizard.xyz'"));
const section = (sql: string) => {
  const start = sql.indexOf("-- ---------- Tester access codes ----------");
  const own = sql.indexOf("create or replace function public.own_plan(uid uuid)");
  return start < 0 || own < 0 ? "" : sql.slice(start, sql.indexOf("\n$$;\n", own));
};
check("the migration matches schema.sql", section(schema) !== "" && section(migration) === section(schema));
check("own_plan() counts Team tester time, then Pro", /case when ta\.team_until > now\(\) then 'team'\s+when ta\.pro_until > now\(\) then 'pro' end\s+from public\.tester_access ta where ta\.user_id = u\.id/.test(section(schema)));
check("redeeming locks the user's tester time (codes redeemed together add up)", /pg_advisory_xact_lock\(hashtext\('tester_access:' \|\| uid::text\)\)/.test(section(schema)));
check("a plan that already gives the code's plan: refused with its plan, before anything is written",
  section(schema).indexOf("raise exception 'already_covered' using errcode = 'P0001', detail = v_code.plan") > 0 &&
  section(schema).indexOf("raise exception 'already_covered'") < section(schema).indexOf("insert into public.access_code_redemptions"));
check("no plain code column", !/\bcode text\b/.test(schema.slice(schema.indexOf("create table if not exists public.access_codes"), schema.indexOf("create table if not exists public.access_code_redemptions"))));

// ---------- The /redeem link ----------
function fakeWindow(url: string, opts: { storage?: "ok" | "blocked" } = {}) {
  const u = new URL(url);
  const loc = { hash: u.hash, pathname: u.pathname, search: u.search, get href() { return `${u.origin}${loc.pathname}${loc.search}${loc.hash}`; } };
  const store = new Map<string, string>();
  const urls: string[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const events: string[] = [];
  const w = {
    addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
    dispatchEvent: (e: Event) => void events.push(e.type),
    // The page's one in-page anchor: the skip link's target.
    document: { getElementById: (id: string) => (id === "main" ? {} : null) },
    location: loc,
    history: {
      state: null as unknown,
      replaceState(_data: unknown, _unused: string, next?: string | null) {
        const n = new URL(next ?? "", loc.href);
        loc.pathname = n.pathname;
        loc.search = n.search;
        loc.hash = n.hash;
        urls.push(loc.href);
      },
    },
    get sessionStorage() {
      if (opts.storage === "blocked") throw new Error("SecurityError");
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };
    },
  } as unknown as CodeWindow & { location: typeof loc };
  // The browser going to another fragment of the same page: popstate, then hashchange.
  const goToFragment = (hash: string) => {
    loc.hash = hash;
    for (const type of ["popstate", "hashchange"]) for (const fn of listeners[type] ?? []) fn();
  };
  return { w, store, urls, events, goToFragment };
}
// The page's globals are the fake window's (getters included), and `window` is it.
const runScript = (w: object) => {
  const globals = Object.defineProperties(Object.create(null), Object.getOwnPropertyDescriptors(w));
  globals.window = w;
  globals.Event = Event;
  vm.runInNewContext(REDEEM_FRAGMENT_SCRIPT, globals);
};

{
  const { w, store, urls } = fakeWindow("https://pdfwizard.xyz/redeem#K7QM-8XRP-2D4N-W9HC");
  runScript(w);
  check("script: the code leaves the address bar", w.location.hash === "" && urls.at(-1) === "https://pdfwizard.xyz/redeem", urls);
  check("script: kept in this tab's sessionStorage", store.get(TESTER_CODE_KEY) === "K7QM-8XRP-2D4N-W9HC");
  check("page: reads it from there", takeTesterCode(w) === "K7QM-8XRP-2D4N-W9HC");
  check("page: the address bar stays clean", w.location.hash === "" && urls.length === 1);
  forgetTesterCode(w);
  check("page: forgets it once used", !store.has(TESTER_CODE_KEY) && takeTesterCode(w) === null);
}
{
  // Another link opened in a tab already on /redeem: only the fragment changes.
  const { w, store, urls, events, goToFragment } = fakeWindow("https://pdfwizard.xyz/redeem");
  runScript(w);
  goToFragment("#ABCD-EFGH-JKMN-PQRS");
  check("same page, new link: the code leaves the address bar at once", w.location.hash === "" && urls.length === 1, urls);
  check("same page, new link: saved, and the page is told", store.get(TESTER_CODE_KEY) === "ABCD-EFGH-JKMN-PQRS" && events.includes(TESTER_CODE_EVENT), events);
  const before = events.length;
  goToFragment("#main");
  check("the skip link (#main) is not taken for a code", w.location.hash === "#main" && urls.length === 1 &&
    events.length === before && store.get(TESTER_CODE_KEY) === "ABCD-EFGH-JKMN-PQRS");
  check("nor by the page", takeTesterCode(w) === "ABCD-EFGH-JKMN-PQRS" && w.location.hash === "#main");
  w.location.pathname = "/privacy";
  goToFragment("#cookies");
  check("on other pages, fragments are left alone", w.location.hash === "#cookies" && urls.length === 1);
}
{
  const { w, urls } = fakeWindow("https://pdfwizard.xyz/redeem?x=1#k7qm%208xrp%202d4n%20w9hc");
  runScript(w);
  check("script: keeps the query, drops the fragment", urls.at(-1) === "https://pdfwizard.xyz/redeem?x=1", urls);
  check("script: decodes an encoded code", formatTesterCode(takeTesterCode(w)) === "K7QM-8XRP-2D4N-W9HC");
}
{
  // After a client-side navigation the script hasn't run: the page does the same.
  const { w, store, urls } = fakeWindow("https://pdfwizard.xyz/redeem#K7QM-8XRP-2D4N-W9HC");
  check("page without the script: reads the fragment", takeTesterCode(w) === "K7QM-8XRP-2D4N-W9HC");
  check("page without the script: clears it and saves the code", w.location.hash === "" && urls.length === 1 &&
    store.get(TESTER_CODE_KEY) === "K7QM-8XRP-2D4N-W9HC");
}
{
  const { w } = fakeWindow("https://pdfwizard.xyz/redeem#K7QM-8XRP-2D4N-W9HC", { storage: "blocked" });
  runScript(w);
  check("blocked storage: the address bar is still cleared", w.location.hash === "");
  check("blocked storage: the code waits in memory", takeTesterCode(w) === "K7QM-8XRP-2D4N-W9HC");
  forgetTesterCode(w);
  check("blocked storage: and is forgotten", takeTesterCode(w) === null);
}
{
  const { w, urls } = fakeWindow("https://pdfwizard.xyz/redeem");
  runScript(w);
  check("no fragment: nothing changes", urls.length === 0 && takeTesterCode(w) === null);
}
{
  const { w } = fakeWindow("https://pdfwizard.xyz/redeem#" + "A".repeat(5000));
  runScript(w);
  check("a huge fragment is cut short, and isn't a code", (takeTesterCode(w) ?? "").length <= 200 && formatTesterCode(takeTesterCode(w)) === null);
}
check("the script is plain ES5 without the code's value", !/=>|`|\blet\b|\bconst\b/.test(REDEEM_FRAGMENT_SCRIPT));

// The script runs first on every page: in <head>, before the consent
// defaults and analytics. Sign-up and log-in links carry no code.
const layout = read("app/layout.tsx");
const head = layout.indexOf("<head>");
check("the root layout runs the script in <head>, before analytics", head > 0 &&
  layout.indexOf("__html: REDEEM_FRAGMENT_SCRIPT", head) > head &&
  layout.indexOf("__html: REDEEM_FRAGMENT_SCRIPT", head) < layout.indexOf("</head>") &&
  layout.indexOf("</head>") < layout.indexOf("<Analytics"));
const page = read("app/redeem/page.tsx");
check("/redeem is not indexed", /robots: \{ index: false/.test(page));
const flow = read("components/TesterAccess.tsx");
check("sign up and log in come back to /redeem, with no code in the URL",
  flow.includes('signupHref("/redeem")') && flow.includes('loginHref("/redeem")') && !/redirect=.*code/i.test(flow));
check("the code goes to the server only in a POST body", /fetch\("\/api\/access\/redeem", \{\s+method: "POST"/.test(flow) &&
  !/\/api\/access\/redeem\?/.test(flow));

// ---------- Tester time ----------
// Kept per plan, as in the database: Team time runs first, then Pro.
const now = new Date("2026-10-19T10:00:00Z");
const pro = (until: string) => ({ teamUntil: null, proUntil: until });
check("running before the end", testerActive(pro("2026-10-19T10:00:00.001Z"), now) && testerPlan(pro("2026-10-19T10:00:00.001Z"), now) === "pro");
check("over at the end exactly (as own_plan())", !testerActive(pro("2026-10-19T10:00:00.000Z"), now));
check("no row: none", !testerActive(null, now) && testerPlan(undefined, now) === null);
const mixed = { teamUntil: "2026-11-02T10:00:00Z", proUntil: "2026-12-02T10:00:00Z" };
check("Team first", testerPlan(mixed, now) === "team");
check("then Pro", testerPlan(mixed, new Date("2026-11-02T10:00:00Z")) === "pro");
check("then none", testerPlan(mixed, new Date("2026-12-02T10:00:00Z")) === null);
check("still to come: Team, then Pro", JSON.stringify(testerTimes(mixed, now)) ===
  JSON.stringify([{ plan: "team", until: mixed.teamUntil }, { plan: "pro", until: mixed.proUntil }]), testerTimes(mixed, now));
check("Pro that ends within Team time is not listed", JSON.stringify(testerTimes({ teamUntil: mixed.proUntil, proUntil: mixed.teamUntil }, now)) ===
  JSON.stringify([{ plan: "team", until: mixed.proUntil }]));
check("all ended: nothing to come, and the part that ended last", testerTimes(mixed, new Date("2027-01-01T00:00:00Z")).length === 0 &&
  lastTesterTime(mixed)?.plan === "pro" && lastTesterTime({ teamUntil: mixed.teamUntil, proUntil: null })?.plan === "team" &&
  lastTesterTime(null) === null);
check("a row from the database", JSON.stringify(parseTesterAccess({ team_until: "2026-11-17T08:00:00+00:00", pro_until: null })) ===
  JSON.stringify({ teamUntil: "2026-11-17T08:00:00+00:00", proUntil: null }));
check("a bad row is none", parseTesterAccess({ team_until: "x", pro_until: null }) === null &&
  parseTesterAccess({ team_until: null, pro_until: null }) === null && parseTesterAccess(null) === null &&
  parseTesterAccess({ plan: "pro", until: "2026-11-17T08:00:00Z" }) === null);
check("label: Pro (tester) until 17 Nov 2026", testerLabel({ plan: "pro", until: "2026-11-17T08:00:00Z" }) === "Pro (tester) until 17 Nov 2026");
check("label in South African time", testerLabel({ plan: "team", until: "2026-11-16T23:30:00Z" }) === "Team (tester) until 17 Nov 2026");
const answer = parseRedeemResult({ plan: "pro", days: 30, until: "2026-11-18T02:06:07.47768+00:00", starts: null });
check("an answer from the route", answer?.days === 30 && answer.starts === null && answer.plan === "pro", answer);
check("one that starts later", parseRedeemResult({ plan: "pro", days: 5, until: "2027-01-06T00:00:00+00:00", starts: "2027-01-01T00:00:00+00:00" })?.starts ===
  "2027-01-01T00:00:00+00:00");
check("a broken answer is none", parseRedeemResult({ plan: "pro", until: "soon", days: 30 }) === null &&
  parseRedeemResult({ plan: "pro", until: "2026-11-18T00:00:00Z" }) === null &&
  parseRedeemResult({ plan: "pro", until: "2026-11-18T00:00:00Z", days: 30, starts: "later" }) === null &&
  parseRedeemResult({ plan: "gold", until: "2026-11-18T00:00:00Z", days: 30 }) === null);
check("covered: names the code's plan", coveredMessage("pro") === "Your plan already includes Pro, so this code would add nothing. It hasn't been used." &&
  coveredMessage("team").includes("includes Team") && coveredMessage(null) === REDEEM_ERRORS.covered && coveredMessage("<b>") === REDEEM_ERRORS.covered);

// ---------- The page ----------
check("success takes focus (the button that had it is gone)", /tabIndex=\{-1\}/.test(flow) && /useEffect\(\(\) => title\.current\?\.focus\(\), \[\]\)/.test(flow));
check("the code form starts afresh for every answer", /<TesterCodeForm key=\{phase\.n\}/.test(flow) && /n: \+\+answers\.current/.test(flow));
check("a plan that already gives it has its own step", /phase\.kind === "covered"/.test(flow) && /answer\.reason === "covered"/.test(flow));
check("no \"free until\" (people who also pay read it as not charged)", !/[Ff]ree until/.test(flow));
const auth = read("components/AuthForm.tsx");
check("sign-up from a tester link: confirm, then open the link again", auth.includes('redirectTo === "/redeem"') &&
  auth.includes("Then open your tester link again."));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll tester code checks passed.");
