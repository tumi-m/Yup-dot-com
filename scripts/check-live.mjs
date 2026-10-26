#!/usr/bin/env node
/**
 * Checks a running PDF Wizard site from the outside, the way the attackers in
 * the 2026 "vibe-coded website hacked" stories worked: browser dev tools and
 * the public anon key, nothing clever.
 *
 *   npm run check:live -- https://pdfwizard.xyz
 *
 * 1. Secrets: fetches pages and every JS chunk they reference, and fails on
 *    a server secret (Supabase service_role JWT or sb_secret_ key, Paystack
 *    sk_live_/sk_test_ key, private key).
 * 2. Headers: HSTS, nosniff, framing, Referrer-Policy and a CSP on a page,
 *    an API response, a static file and an error page.
 * 3. Files that must not be public (/.env, /.git/config, source code,
 *    source maps): 404.
 * 4. Pages and routes signed out: every private page in scripts/routes.mjs
 *    must redirect to /login (as HTML and as an RSC request) with no private
 *    data, also with .png on the end; every closed route must refuse a GET.
 *    With --routes, a route the build has that the list doesn't fails.
 * 5. Database: reads the Supabase URL and public key from the site's own
 *    scripts. Every table and view in supabase/schema.sql or in the API's
 *    listing must refuse reads and writes (insert, update, delete, sent so
 *    they change nothing); every SECURITY DEFINER function there and every
 *    function the API lists is called read-only and must be refused; every
 *    bucket in supabase/*.sql or the listing must list nothing and not be
 *    public. Also checks that Supabase's "Confirm email" is on. With a test
 *    account (CHECK_LIVE_EMAIL and CHECK_LIVE_PASSWORD), the same again
 *    signed in: only that account's own rows and files may come back.
 * 6. /.well-known/security.txt is there and not expired.
 *
 * Options:
 *   --env-values        also fail on the value of any server-only variable set
 *                       in this environment (CI, against a build made with them)
 *   --routes FILE       the build's .next/app-path-routes-manifest.json: fail on
 *                       a route that isn't in scripts/routes.mjs
 *   --skip-supabase     skip the database checks
 *   --supabase-url URL  use this Supabase URL instead of the one in the scripts
 *   --quiet             print failures, warnings and the summary only
 *
 * The test account is an ordinary account made for this (sign up, confirm
 * the email, never use it for anything else). With Supabase's CAPTCHA on,
 * the signed-in checks can't sign in; leave the two variables unset then.
 *
 * Needs Node 20 or later and nothing else. Exit code: 0 all passed,
 * 1 a check failed, 2 the site couldn't be checked.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mainAddress } from "./lib/site-redirect.mjs";

const secretScan = createRequire(import.meta.url)("../lib/secret-scan.cjs");

// ---------- Arguments ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith("--") && !["--supabase-url", "--routes"].includes(args[i - 1]));
if (!target || !/^https?:\/\//.test(target)) {
  console.error("Usage: npm run check:live -- https://your-site [--env-values] [--routes .next/app-path-routes-manifest.json] [--skip-supabase] [--supabase-url URL] [--quiet]");
  process.exit(2);
}
let SITE = new URL(target).origin;
const HTTPS = SITE.startsWith("https:");
const QUIET = flag("--quiet");
const TIMEOUT = 20_000;
const UA = "pdfwizard-check-live/1 (+https://github.com/tumi-m/Yup-dot-com)";
const envValues = flag("--env-values") ? secretScan.serverValues(process.env) : [];

// ---------- Report ----------
const results = [];
const warnings = [];
let section = "";
const pass = (msg) => results.push({ section, ok: true, msg });
const fail = (msg) => results.push({ section, ok: false, msg });
// Not a failure, but printed even with --quiet: something couldn't be checked.
const warn = (msg) => warnings.push(msg);

// ---------- HTTP ----------
async function request(url, { method = "GET", headers = {}, body, maxBytes = 15e6 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { "user-agent": UA, ...headers },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { url: String(url), status: res.status, headers: res.headers, text: buf.subarray(0, maxBytes).toString("utf8") };
}
const at = (path) => new URL(path, SITE).href;
const get = (path, opts) => request(at(path), opts).catch((err) => ({ url: at(path), status: 0, headers: new Headers(), text: "", error: err }));

async function pool(items, size, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

const pathOf = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

// Every response body is searched for secrets, and for this environment's
// server-only values with --env-values.
const leaks = new Map();
function scan(res, label = pathOf(res.url)) {
  for (const { kind, sample } of secretScan.findSecrets(res.text)) leaks.set(`${label}|${kind}`, `${label}: ${kind} (${sample})`);
  for (const [name, value] of envValues) if (res.text.includes(value)) leaks.set(`${label}|${name}`, `${label}: the value of ${name}`);
}

// ---------- 1. Pages and scripts ----------
section = "Secrets in what browsers download";
let home = await get("/");
// The address given may only send visitors on to the site's main address
// (pdfwizard.xyz → www.pdfwizard.xyz, or the reverse): check that one, and say so.
{
  const main = [301, 302, 307, 308].includes(home.status) ? mainAddress(SITE, home.headers.get("location")) : null;
  if (main) {
    warn(`${SITE} redirects to ${main}, so ${main} was checked. Make the address you use everywhere (SITE_URL, NEXT_PUBLIC_SITE_URL, Supabase, Paystack) the main domain in Vercel, or set SITE_URL to ${main}.`);
    SITE = main;
    home = await get("/");
  }
}
if (home.status === 0 || home.status >= 500) {
  const why = `Couldn't load ${SITE}/ (${home.error?.message ?? `HTTP ${home.status}`}).`;
  console.error(why);
  if (process.env.GITHUB_ACTIONS === "true") console.log(`::error title=Site unreachable::${why}`);
  process.exit(2);
}

const pagePaths = new Set(["/", "/login", "/signup", "/pricing", "/tools", "/security", "/forgot-password"]);
const sitemap = await get("/sitemap.xml");
if (sitemap.status === 200) {
  for (const m of sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    try {
      const u = new URL(m[1].trim());
      // The sitemap may name the production domain; check the same paths here.
      if (pagePaths.size < 80) pagePaths.add(u.pathname);
    } catch {}
  }
}

const pages = await pool([...pagePaths], 6, async (path) => {
  const html = await get(path);
  const rsc = await get(path, { headers: { RSC: "1" } });
  return { path, html, rsc };
});

const chunkUrls = new Set();
const addChunks = (text, base) => {
  for (const m of text.matchAll(/(?:src|href)=["']([^"']+?\.js)(?:\?[^"']*)?["']/g)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), base);
      if (u.origin === SITE) chunkUrls.add(u.href.split("?")[0]);
    } catch {}
  }
  for (const m of text.matchAll(/["'`(]((?:\/_next\/|_next\/)?static\/(?:chunks|[\w-]+)\/[^"'`\s()]+?\.js)["'`)]/g)) {
    const p = m[1].replace(/^\/?(?:_next\/)?/, "/_next/");
    chunkUrls.add(at(p));
  }
};
for (const { html, rsc } of pages) {
  scan(html);
  scan(rsc, `${pathOf(rsc.url)} (RSC)`);
  addChunks(html.text, html.url);
  addChunks(rsc.text, rsc.url);
}

// Scripts, and the scripts they load, up to 400 files.
const scripts = new Map();
let queue = [...chunkUrls];
while (queue.length && scripts.size < 400) {
  const batch = queue.filter((u) => !scripts.has(u)).slice(0, 400 - scripts.size);
  queue = [];
  const fetched = await pool(batch, 8, (u) => request(u).catch(() => null));
  batch.forEach((u, i) => {
    const res = fetched[i];
    scripts.set(u, res);
    if (res?.status === 200) {
      scan(res);
      const before = chunkUrls.size;
      addChunks(res.text, u);
      if (chunkUrls.size > before) queue.push(...[...chunkUrls].filter((x) => !scripts.has(x)));
    }
  });
}
const goodScripts = [...scripts.values()].filter((r) => r?.status === 200);
if (!goodScripts.length) fail("No JavaScript found on the site, so the search can't be trusted.");
else if (!leaks.size) pass(`${goodScripts.length} scripts and ${pages.length} pages (HTML and RSC): no secret keys${envValues.length ? ` or server-only values (${envValues.length})` : ""}`);

// ---------- 2. Security headers ----------
const directive = (csp, name) => csp.split(";").map((d) => d.trim()).find((d) => d.toLowerCase().startsWith(name + " "));
function headerProblems(h, kind) {
  const problems = [];
  if (HTTPS) {
    const age = /max-age=(\d+)/i.exec(h.get("strict-transport-security") ?? "");
    if (!age || Number(age[1]) < 15552000) problems.push("Strict-Transport-Security of 6 months or more");
  }
  if ((h.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") problems.push("X-Content-Type-Options: nosniff");
  const csp = h.get("content-security-policy") ?? "";
  if (!/frame-ancestors/i.test(csp) && !/^(deny|sameorigin)$/i.test(h.get("x-frame-options") ?? "")) problems.push("X-Frame-Options or frame-ancestors");
  if (!h.get("referrer-policy")) problems.push("Referrer-Policy");
  if (!csp) problems.push("Content-Security-Policy");
  if (kind === "page" && csp) {
    const script = directive(csp, "script-src") ?? directive(csp, "default-src");
    if (!script) problems.push("a CSP script-src (any injected script would run)");
    else {
      if (/'unsafe-inline'/.test(script) && !/'nonce-|'sha(256|384|512)-|'strict-dynamic'/.test(script)) problems.push("a CSP that blocks inline scripts");
      if (/'unsafe-eval'/.test(script)) problems.push("a CSP without 'unsafe-eval'");
    }
    if (!/object-src 'none'/.test(csp) && !/default-src 'none'/.test(csp)) problems.push("CSP object-src 'none'");
  }
  if (h.get("x-powered-by")) problems.push("no X-Powered-By header");
  return problems;
}

section = "Security headers";
const firstScript = goodScripts[0];
const missingId = randomUUID().slice(0, 8);
const missing = await get(`/check-live-missing-${missingId}`);
// A page path ending in an image extension must still get the page's CSP.
const missingPng = await get(`/check-live-missing-${missingId}.png`);
const api = await get("/api/prices");
// Redirects made outside the app (next.config) used to lose the headers.
const legacyTxt = await get("/security.txt");
for (const [label, res, kind] of [
  [`page /`, home, "page"],
  [`API /api/prices`, api, "api"],
  [`static ${firstScript ? pathOf(firstScript.url) : "(no script)"}`, firstScript, "static"],
  [`error page (HTTP ${missing.status})`, missing, "page"],
  [`error page ending in .png (HTTP ${missingPng.status})`, missingPng, "page"],
  [`redirect /security.txt (HTTP ${legacyTxt.status})`, legacyTxt, "static"],
]) {
  if (!res || res.status === 0) {
    fail(`${label}: no response`);
    continue;
  }
  const problems = headerProblems(res.headers, kind);
  if (problems.length) fail(`${label}: missing ${problems.join(", ")}`);
  else pass(`${label}: ${kind === "page" ? "HSTS, nosniff, framing, referrer, CSP with script-src" : "HSTS, nosniff, framing, referrer, CSP"}${HTTPS ? "" : " (HSTS not checked over http)"}`);
}
if (missing.status !== 404) fail(`a page that doesn't exist answered HTTP ${missing.status}, not 404`);
if (missingPng.status !== 404) fail(`a path that doesn't exist, ending in .png, answered HTTP ${missingPng.status}, not 404`);

// ---------- 3. Files that must not be public ----------
section = "Files that must not be public";
const FILES = [
  "/.env", "/.env.local", "/.env.production", "/.env.example", "/.git/config", "/.git/HEAD",
  "/.vercel/project.json", "/package.json", "/package-lock.json", "/next.config.ts", "/tsconfig.json",
  "/supabase/schema.sql", "/.next/BUILD_ID", "/_next/BUILD_ID", "/proxy.ts", "/lib/supabase/server.ts",
];
const exposed = [];
await pool(FILES, 6, async (path) => {
  const res = await get(path);
  const html = /^\s*</.test(res.text) && /text\/html/.test(res.headers.get("content-type") ?? "");
  if (res.status === 200 && !html) exposed.push(`${path} (HTTP 200, ${res.text.length} bytes)`);
  else if (res.status === 0) exposed.push(`${path} (no response)`);
});
if (exposed.length) for (const e of exposed) fail(`${e} is served`);
else pass(`${FILES.length} paths (/.env, /.git/config, package.json, source files…): not served`);

// Source maps would hand out the source code.
const maps = [];
await pool(goodScripts.slice(0, 40), 6, async (script) => {
  const named = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(script.text)?.[1];
  const url = named && !named.startsWith("data:") ? new URL(named, script.url).href : `${script.url}.map`;
  const res = await request(url).catch(() => null);
  if (res?.status !== 200) return;
  let map = null;
  try {
    map = JSON.parse(res.text);
  } catch {}
  const sources = [...(map?.sources ?? []), ...(map?.sections ?? []).flatMap((s) => s.map?.sources ?? [])];
  const content = [...(map?.sourcesContent ?? []), ...(map?.sections ?? []).flatMap((s) => s.map?.sourcesContent ?? [])].filter(Boolean);
  if (sources.length || content.length) maps.push(`${pathOf(url)} (${sources.length} source files)`);
});
if (maps.length) for (const m of maps) fail(`source map served: ${m}`);
else pass(`source maps: none with source code (${Math.min(goodScripts.length, 40)} scripts checked)`);

// ---------- 4. Pages and routes, signed out ----------
section = "Private pages and routes, signed out";
const publicText = pages.map((p) => p.html.text).join("\n");
const knownEmails = new Set(publicText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []);
function privateData(text) {
  const found = [];
  // RSC payloads carry JSON inside strings, with escaped quotes.
  if (/\\?"(?:paystack_[a-z_]+|storage_path|owner_id|access_token|refresh_token|subscription_code|email_token|full_name)\\?"\s*:/.test(text)) found.push("account fields");
  if (/\b(?:CUS|SUB)_[A-Za-z0-9]{8,}/.test(text)) found.push("Paystack customer or subscription codes");
  if (secretScan.findSecrets(text).length) found.push("a session or secret key");
  const emails = (text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).filter((e) => !knownEmails.has(e) && !/@(?:example\.(?:com|org|net)|[\w.-]+\.(?:test|invalid))$/i.test(e));
  if (emails.length) found.push(`email addresses (${emails.length})`);
  return found;
}
// The page and route lists sit next to this script; outside the repository
// the private pages and routes known when it was written are used.
const routeList = await import(new URL("./routes.mjs", import.meta.url).href).catch(() => ({
  PUBLIC_PAGES: [],
  PUBLIC_ROUTES: [],
  PRIVATE_PAGES: ["/dashboard", "/editor/[id]", "/settings/billing", "/settings/password"],
  CLOSED_ROUTES: ["/api/access/redeem", "/api/billing/team", "/api/billing/verify", "/api/media/health"],
}));
const fill = (path) => path.replace(/\[\[?\.{0,3}[^\]]+\]\]?/g, () => randomUUID());
const shown = (path) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");

if (option("--routes")) {
  // Every route the build has must be in scripts/routes.mjs.
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(option("--routes"), "utf8"));
  } catch (err) {
    fail(`--routes: couldn't read ${option("--routes")} (${err.message})`);
  }
  if (manifest) {
    const known = new Set([...routeList.PUBLIC_PAGES, ...routeList.PRIVATE_PAGES, ...routeList.PUBLIC_ROUTES, ...routeList.CLOSED_ROUTES]);
    const built = [...new Set(Object.values(manifest))].filter((r) => !/^\/_(?:not-found|global-error|error)$/.test(r));
    const unknown = built.filter((r) => !known.has(r));
    for (const r of unknown) fail(`${r}: the build has this route but scripts/routes.mjs doesn't say whether it's public or private`);
    if (!unknown.length) pass(`all ${built.length} routes of the build are listed in scripts/routes.mjs`);
  }
}

const PRIVATE = routeList.PRIVATE_PAGES.map(fill);
// The same with .png on the end, once for a dynamic page: it used to skip the proxy.
const dynamicPrivate = routeList.PRIVATE_PAGES.find((p) => p.includes("["));
if (dynamicPrivate) PRIVATE.push(`${fill(dynamicPrivate)}.png`);
for (const path of PRIVATE) {
  for (const [how, headers] of [["page", {}], ["RSC", { RSC: "1", "Next-Router-Prefetch": "1" }]]) {
    const res = await get(path, { headers });
    const label = `${shown(path)} (${how})`;
    const location = res.headers.get("location") ?? "";
    const toLogin = res.status >= 300 && res.status < 400 && /\/login\b/.test(location);
    const denied = [401, 403, 404].includes(res.status);
    const data = privateData(res.text);
    const csp = headerProblems(res.headers, "page");
    if (data.length) fail(`${label}: HTTP ${res.status} carries ${data.join(", ")}`);
    else if (!toLogin && !denied) fail(`${label}: HTTP ${res.status}${location ? ` to ${location}` : ""}, not a redirect to /login`);
    else if (how === "page" && csp.length) fail(`${label}: HTTP ${res.status} but missing ${csp.join(", ")}`);
    else pass(`${label}: ${toLogin ? `${res.status} to ${new URL(location, SITE).pathname}` : `HTTP ${res.status}`}, no private data`);
  }
}

// Routes that need an account, a signature, a POST or the owner.
const closed = await pool(routeList.CLOSED_ROUTES, 6, async (path) => ({ path, res: await get(fill(path)) }));
const opened = [];
for (const { path, res } of closed) {
  const data = privateData(res.text);
  if (res.status === 0) opened.push(`${path}: no response`);
  else if (res.status >= 200 && res.status < 300) opened.push(`${path}: HTTP ${res.status} to a signed-out GET${data.length ? `, with ${data.join(", ")}` : ""}`);
  else if (data.length) opened.push(`${path}: HTTP ${res.status} carries ${data.join(", ")}`);
}
if (opened.length) for (const o of opened) fail(o);
else if (closed.length) pass(`${closed.length} closed routes (/api/billing/*, /api/media/*, /auth/*…): none answers a signed-out GET`);

// ---------- 5. Database, with the site's own public key ----------
section = "Database (Supabase) with the site's public key";
function publicSupabase() {
  const all = [home, ...pages.map((p) => p.html), ...goodScripts].map((r) => r.text).join("\n");
  let key = null;
  let keyAt = -1;
  for (const m of all.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g)) {
    if (secretScan.jwtPayload(m[0])?.role === "anon") {
      key = m[0];
      keyAt = m.index;
      break;
    }
  }
  if (!key) {
    const m = /sb_publishable_[A-Za-z0-9_-]{10,}/.exec(all);
    if (m) [key, keyAt] = [m[0], m.index];
  }
  let url = option("--supabase-url") ?? /https:\/\/[a-z0-9-]+\.supabase\.(?:co|in)\b/.exec(all)?.[0];
  if (!url && keyAt >= 0) {
    // The URL is inlined next to the key (lib/supabase/config.ts).
    const near = [...all.slice(Math.max(0, keyAt - 600), keyAt).matchAll(/["'`](https?:\/\/[^"'`\s]+)["'`]/g)].pop();
    url = near?.[1];
  }
  return { url: url?.replace(/\/+$/, ""), key };
}

/**
 * Tables and views (with a column, for the update and delete checks),
 * SECURITY DEFINER functions (with arguments) and storage buckets, from
 * supabase/*.sql when this runs from the repository.
 */
function appSchema() {
  const dir = new URL("../supabase/", import.meta.url);
  let files = [];
  try {
    files = ["schema.sql", ...readdirSync(new URL("migrations/", dir)).map((f) => `migrations/${f}`)].map((f) => new URL(f, dir)).filter((u) => existsSync(u));
  } catch {}
  const sql = files.map((u) => readFileSync(u, "utf8")).join("\n");
  const tables = new Map();
  for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(\s*(\w+)/gi)) tables.set(m[1], m[2]);
  for (const m of sql.matchAll(/create (?:or replace )?(?:materialized )?view (?:if not exists )?public\.(\w+)/gi)) if (!tables.has(m[1])) tables.set(m[1], null);
  const functions = new Map();
  for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)\s*returns (\w+)([\s\S]*?)\bas \$\$/gi)) {
    if (["trigger", "event_trigger"].includes(m[3].toLowerCase()) || !/security definer/i.test(m[4])) continue;
    const params = {};
    for (const part of m[2].split(",").map((x) => x.trim()).filter(Boolean)) {
      const [name, type] = part.split(/\s+/);
      params[name] = sampleArg(type);
    }
    functions.set(m[1], params);
  }
  const buckets = new Set([...sql.matchAll(/insert into storage\.buckets\s*\([^)]*\)\s*values\s*\(\s*'([^']+)'/gi)].map((m) => m[1]));
  if (!tables.size) {
    for (const t of ["profiles", "documents", "team_members", "billing_events", "usage_counters", "access_codes", "access_code_redemptions", "tester_access"]) tables.set(t, null);
  }
  if (!functions.size) {
    const uid = { uid: sampleArg("uuid") };
    const usage = { p_key: "x", p_bucket: "x", p_window: "day" };
    for (const [n, p] of [
      ["own_plan", uid],
      ["effective_plan", uid],
      ["consume_usage", { ...usage, p_limit: 1 }],
      ["refund_usage", usage],
      ["usage_count", usage],
      ["create_tester_code", {}],
      ["list_tester_codes", {}],
      ["revoke_tester_code", { code_or_ref: "x" }],
      ["redeem_tester_code", { ...uid, code: "x", dry_run: true }],
    ]) functions.set(n, p);
  }
  if (!buckets.size) buckets.add("documents");
  return { tables, functions, buckets };
}

/** A harmless value for an argument of this type. */
function sampleArg(type = "") {
  if (/uuid/i.test(type)) return "00000000-0000-4000-8000-000000000000";
  if (/int|numeric|real|double|bigint|smallint/i.test(type)) return 1;
  if (/bool/i.test(type)) return false;
  return "day";
}

if (flag("--skip-supabase")) {
  pass("skipped (--skip-supabase)");
} else {
  const sb = publicSupabase();
  if (!sb.key || !sb.url) {
    fail(`couldn't find the Supabase ${sb.key ? "URL" : "public key"} in the site's scripts, so the database wasn't checked (use --supabase-url, or --skip-supabase if the site has no accounts)`);
  } else {
    await checkDatabase(sb);
  }
}

async function checkDatabase(sb) {
  const base = { apikey: sb.key, accept: "application/json" };
  const anonAuth = sb.key.startsWith("eyJ") ? { authorization: `Bearer ${sb.key}` } : {};
  const caller = (auth) => (path, opts = {}) =>
    request(`${sb.url}${path}`, { ...opts, headers: { ...base, ...auth, ...(opts.headers ?? {}) } }).catch((err) => ({ status: 0, text: "", headers: new Headers(), error: err }));
  const call = caller(anonAuth);
  const json = (res) => {
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  };
  const code = (res) => json(res)?.code;
  const refused = (res) => [401, 403].includes(res.status) || code(res) === "42501";
  const how = (res) => `HTTP ${res.status}${code(res) ? `, ${code(res)}` : ""}${res.error ? `, ${res.error.message}` : ""}`;
  const schema = appSchema();

  /** What PostgREST lists for this caller (it lists only what the caller may use). */
  async function listing(callFn, who) {
    const res = await callFn("/rest/v1/");
    const doc = json(res);
    if (res.status !== 200 || !doc?.paths) {
      warn(`Couldn't list the database API ${who} (${how(res)}), so only the tables and functions named in supabase/*.sql were checked ${who}. Run supabase/audit.sql in the Supabase SQL editor to cover anything added by hand.`);
      return { tables: new Map(), functions: new Map() };
    }
    const tables = new Map();
    const functions = new Map();
    for (const [path, ops] of Object.entries(doc.paths)) {
      const name = path.replace(/^\//, "");
      if (!name) continue;
      if (name.startsWith("rpc/")) {
        const params = {};
        for (const p of ops?.get?.parameters ?? []) if (p?.in === "query" && p.name) params[p.name] = sampleArg(p.format ?? p.type);
        functions.set(name.slice(4), params);
      } else {
        tables.set(name, Object.keys(doc.definitions?.[name]?.properties ?? {})[0] ?? null);
      }
    }
    return { tables, functions };
  }

  // ----- With the public key alone -----
  const listed = await listing(call, "with the public key");
  const listedNames = [...listed.tables.keys(), ...[...listed.functions.keys()].map((f) => `${f}()`)];
  if (listedNames.length) warn(`The database API lists these for the public key, so each was checked: ${listedNames.join(", ")}.`);
  const tables = new Map(schema.tables);
  for (const [t, col] of listed.tables) if (!tables.has(t) || !tables.get(t)) tables.set(t, col);
  const functions = new Map(schema.functions);
  for (const [f, params] of listed.functions) if (!functions.has(f)) functions.set(f, params);

  await pool([...tables], 4, async ([t, col]) => {
    const path = `/rest/v1/${encodeURIComponent(t)}`;
    const read = await call(`${path}?select=*&limit=3`);
    const rows = json(read);
    const problems = [];
    if (read.status === 200 && Array.isArray(rows) && rows.length) problems.push(`returns rows to anyone with the public key (${rows.length}+)`);
    else if (read.status === 200) problems.push("the public key may read it (no rows now; every row would show if RLS were ever off)");
    else if (!refused(read) && read.status !== 404) problems.push(`read couldn't be checked (${how(read)})`);
    if (read.status === 404) {
      pass(`table ${t}: not exposed`);
      return;
    }
    // Writes that would change nothing if they got through: no rows, or a filter nothing matches.
    const none = col ? `?${encodeURIComponent(col)}=is.null&${encodeURIComponent(col)}=not.is.null` : null;
    const writes = [
      ["insert", () => call(path, { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: "[]" })],
      ...(none
        ? [
            ["update", () => call(`${path}${none}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ [col]: null }) })],
            ["delete", () => call(`${path}${none}`, { method: "DELETE", headers: { prefer: "return=minimal" } })],
          ]
        : []),
    ];
    for (const [verb, send] of writes) {
      const res = await send();
      if (res.status >= 200 && res.status < 300) problems.push(`accepts ${verb}s from the public key`);
      else if (!refused(res) && ![404, 405].includes(res.status)) problems.push(`${verb} couldn't be checked (${how(res)})`);
    }
    if (problems.length) for (const p of problems) fail(`table ${t}: ${p}`);
    else pass(`table ${t}: read${writes.length > 1 ? ", insert, update and delete" : " and insert"} refused`);
  });

  /** Calls a function read-only (GET), so even one that writes changes nothing. */
  async function callFunction(callFn, fn, params, who, isListed) {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res = await callFn(`/rest/v1/rpc/${encodeURIComponent(fn)}${qs ? `?${qs}` : ""}`);
    const c = code(res);
    if (res.status >= 200 && res.status < 300) return `runs for ${who}`;
    if (c === "25006") return `runs for ${who} (it tried to write; called read-only, nothing changed)`;
    if (refused(res)) return null;
    if (res.status === 404) return isListed ? `couldn't be called to check it (${how(res)})` : null;
    if (res.status === 0 || res.status >= 500 || res.status === 405) return `couldn't be checked (${how(res)})`;
    return `ran and failed (${how(res)}), so ${who} may call it`;
  }
  await pool([...functions], 4, async ([fn, params]) => {
    const problem = await callFunction(call, fn, params, "anyone with the public key", listed.functions.has(fn));
    if (problem) fail(`function ${fn}(): ${problem}`);
    else pass(`function ${fn}(): refused`);
  });

  // Buckets: those in supabase/*.sql, any the storage API shows, any the
  // site's scripts name (storage.from("…")), and the names people usually
  // pick, as an attacker would guess them. A bucket with a name nobody would
  // guess only shows up in supabase/audit.sql.
  const buckets = new Map([...schema.buckets].map((b) => [b, null]));
  const listedBuckets = json(await call("/storage/v1/bucket"));
  if (Array.isArray(listedBuckets)) for (const b of listedBuckets) if (b?.id) buckets.set(b.id, b.public ?? null);
  for (const m of goodScripts.map((r) => r.text).join("\n").matchAll(/\.storage\.from\(\s*["'`]([\w.-]{1,63})["'`]/g)) if (!buckets.has(m[1])) buckets.set(m[1], null);
  const guessed = ["avatars", "public", "uploads", "images", "files", "media", "attachments", "assets", "private", "backups", "exports", "documents"].filter((b) => !buckets.has(b));
  for (const b of guessed) buckets.set(b, null);
  await pool([...buckets], 4, async ([id, isPublic]) => {
    const problems = [];
    const res = await call(`/storage/v1/object/list/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }) });
    const items = json(res);
    if (res.status === 200 && Array.isArray(items) && items.length) problems.push(`lists ${items.length} item(s) to anyone with the public key`);
    else if (!(res.status === 200 || [400, 401, 403, 404].includes(res.status))) problems.push(`couldn't be checked (${how(res)})`);
    // A public bucket hands out any file whose name is known, policies or not.
    const probe = await call(`/storage/v1/object/public/${encodeURIComponent(id)}/check-live-${randomUUID()}.txt`);
    if (isPublic === true || probe.status === 200 || /object not found/i.test(probe.text)) problems.push("is public (anyone can download a file whose name they know)");
    if (problems.length) for (const p of problems) fail(`bucket ${id}: ${p}`);
    else if (!guessed.includes(id)) pass(`bucket ${id}: private, nothing listed`);
  });
  pass(`common bucket names (${guessed.join(", ")}): none public or listable`);

  {
    const res = await call("/auth/v1/settings");
    const body = json(res);
    if (body && body.mailer_autoconfirm === true) fail(`Auth: "Confirm email" is off (sign-up then shows which emails have accounts, and team seats rely on confirmed emails)`);
    else if (body && body.mailer_autoconfirm === false) pass(`Auth: "Confirm email" is on`);
    else fail(`Auth settings: couldn't check (HTTP ${res.status})`);
  }

  // ----- Signed in as an ordinary account -----
  const email = process.env.CHECK_LIVE_EMAIL?.trim();
  const password = process.env.CHECK_LIVE_PASSWORD;
  if (!email || !password) {
    warn("No test account (CHECK_LIVE_EMAIL, CHECK_LIVE_PASSWORD), so what any signed-up user can read wasn't checked from outside (scripts/test-rls.sh checks it for the known tables).");
    return;
  }
  section = "Database, signed in as the test account";
  const login = await call("/auth/v1/token?grant_type=password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const session = json(login);
  if (login.status !== 200 || !session?.access_token || !session?.user?.id) {
    const msg = String(session?.msg ?? session?.error_description ?? session?.message ?? "");
    fail(`couldn't sign in the test account (HTTP ${login.status}${/captcha/i.test(msg) ? ": CAPTCHA is on, so this check can't sign in; unset CHECK_LIVE_EMAIL" : ""})`);
    return;
  }
  const uid = session.user.id;
  const userEmail = String(session.user.email ?? email).toLowerCase();
  const asUser = caller({ authorization: `Bearer ${session.access_token}` });
  const own = (row) =>
    row && typeof row === "object" &&
    (["id", "owner_id", "user_id", "profile_id", "account_id", "created_by"].some((k) => row[k] === uid) || String(row.email ?? "").toLowerCase() === userEmail);

  const mine = await listing(asUser, "as the test account");
  const userTables = new Map(tables);
  for (const [t, col] of mine.tables) if (!userTables.has(t)) userTables.set(t, col);
  await pool([...userTables.keys()], 4, async (t) => {
    const res = await asUser(`/rest/v1/${encodeURIComponent(t)}?select=*&limit=50`);
    const rows = json(res);
    if (res.status === 200 && Array.isArray(rows)) {
      const others = rows.filter((r) => !own(r));
      if (others.length) fail(`table ${t}: any signed-up user gets ${others.length} row(s) that aren't theirs`);
      else pass(`table ${t}: only the account's own rows (${rows.length})`);
    } else if (refused(res) || res.status === 404) pass(`table ${t}: ${res.status === 404 ? "not exposed" : "refused"}`);
    else fail(`table ${t}: couldn't check signed in (${how(res)})`);
  });
  const userFunctions = new Map(functions);
  for (const [f, params] of mine.functions) if (!userFunctions.has(f)) userFunctions.set(f, params);
  await pool([...userFunctions], 4, async ([fn, params]) => {
    const problem = await callFunction(asUser, fn, params, "any signed-up user", mine.functions.has(fn));
    if (problem) fail(`function ${fn}(): ${problem}`);
    else pass(`function ${fn}(): refused`);
  });
  await pool([...buckets.keys()], 4, async (id) => {
    const res = await asUser(`/storage/v1/object/list/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }) });
    const items = json(res);
    const others = Array.isArray(items) ? items.filter((i) => !(i?.name === uid || String(i?.name ?? "").startsWith(`${uid}/`))) : [];
    if (others.length) fail(`bucket ${id}: any signed-up user sees ${others.length} item(s) outside their own folder`);
    else if (!guessed.includes(id)) pass(`bucket ${id}: only the account's own folder`);
  });
  await asUser("/auth/v1/logout", { method: "POST" });
}

// ---------- 6. security.txt ----------
section = "Security contact";
{
  const res = await get("/.well-known/security.txt");
  const contact = /^Contact:\s*(\S+)/m.exec(res.text)?.[1];
  const expires = Date.parse(/^Expires:\s*(\S+)/m.exec(res.text)?.[1] ?? "");
  if (res.status !== 200 || !contact) fail(`/.well-known/security.txt: missing (HTTP ${res.status})`);
  else if (!(expires > Date.now())) fail(`/.well-known/security.txt: expired or no Expires`);
  else pass(`/.well-known/security.txt: ${contact}, expires ${new Date(expires).toISOString().slice(0, 10)}`);
}

// Secrets found anywhere above.
if (leaks.size) {
  section = "Secrets in what browsers download";
  for (const leak of leaks.values()) fail(leak);
}

// ---------- Report ----------
const order = [...new Set(results.map((r) => r.section))];
const failed = results.filter((r) => !r.ok);
console.log(`Live check: ${SITE}`);
for (const s of order) {
  const rows = results.filter((r) => r.section === s && (!QUIET || !r.ok));
  if (!rows.length) continue;
  console.log(`\n${s}`);
  for (const r of rows.sort((a, b) => Number(a.ok) - Number(b.ok))) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.msg}`);
}
if (warnings.length) {
  console.log("\nWarnings (not failures)");
  for (const w of warnings) console.log(`  WARN  ${w}`);
}
console.log(`\n${failed.length ? `FAILED: ${failed.length} of ${results.length} checks` : `All ${results.length} checks passed`}.`);

// In GitHub Actions: each failure and warning becomes an annotation on the
// run (shown in the failure email and on the run page), and the report goes
// into the job summary.
if (process.env.GITHUB_ACTIONS === "true") {
  const data = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s) => data(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  for (const r of failed) console.log(`::error title=${prop(r.section)}::${data(r.msg)}`);
  for (const w of warnings) console.log(`::warning title=Couldn't check::${data(w)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`## Live check: ${SITE}`, "", failed.length ? `**${failed.length} of ${results.length} checks failed.**` : `All ${results.length} checks passed.`, ""];
    for (const s of order) {
      md.push(`### ${s}`, "");
      for (const r of results.filter((x) => x.section === s).sort((a, b) => Number(a.ok) - Number(b.ok))) md.push(`- ${r.ok ? "✅" : "❌"} ${r.msg}`);
      md.push("");
    }
    if (warnings.length) md.push("### Couldn't check", "", ...warnings.map((w) => `- ⚠️ ${w}`), "");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
  }
}
process.exit(failed.length ? 1 : 0);
