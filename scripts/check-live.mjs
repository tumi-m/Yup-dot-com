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
 * 4. Private pages signed out (dashboard, billing, password, editor): a
 *    redirect to /login, as HTML and as an RSC request, with no private data.
 * 5. Database: reads the Supabase URL and public key from the site's own
 *    scripts and asks PostgREST for every app table and view, calls every
 *    SECURITY DEFINER function, and lists the documents bucket. Anything but
 *    "no rows" or "permission denied" fails. Also checks that Supabase's
 *    "Confirm email" is on.
 * 6. /.well-known/security.txt is there and not expired.
 *
 * Options:
 *   --env-values        also fail on the value of any server-only variable set
 *                       in this environment (CI, against a build made with them)
 *   --skip-supabase     skip the database checks
 *   --supabase-url URL  use this Supabase URL instead of the one in the scripts
 *   --quiet             print failures and the summary only
 *
 * Needs Node 20 or later and nothing else. Exit code: 0 all passed,
 * 1 a check failed, 2 the site couldn't be checked.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const secretScan = createRequire(import.meta.url)("../lib/secret-scan.cjs");

// ---------- Arguments ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--supabase-url");
if (!target || !/^https?:\/\//.test(target)) {
  console.error("Usage: npm run check:live -- https://your-site [--env-values] [--skip-supabase] [--supabase-url URL] [--quiet]");
  process.exit(2);
}
const SITE = new URL(target).origin;
const HTTPS = SITE.startsWith("https:");
const QUIET = flag("--quiet");
const TIMEOUT = 20_000;
const UA = "pdfwizard-check-live/1 (+https://github.com/tumi-m/Yup-dot-com)";
const envValues = flag("--env-values") ? secretScan.serverValues(process.env) : [];

// ---------- Report ----------
const results = [];
let section = "";
const pass = (msg) => results.push({ section, ok: true, msg });
const fail = (msg) => results.push({ section, ok: false, msg });

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
const home = await get("/");
if (home.status === 0 || home.status >= 500) {
  console.error(`Couldn't load ${SITE}/ (${home.error?.message ?? `HTTP ${home.status}`}).`);
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
const missing = await get(`/check-live-missing-${randomUUID().slice(0, 8)}`);
const api = await get("/api/prices");
for (const [label, res, kind] of [
  [`page /`, home, "page"],
  [`API /api/prices`, api, "api"],
  [`static ${firstScript ? pathOf(firstScript.url) : "(no script)"}`, firstScript, "static"],
  [`error page (HTTP ${missing.status})`, missing, "page"],
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

// ---------- 4. Private pages, signed out ----------
section = "Private pages, signed out";
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
const PRIVATE = ["/dashboard", "/settings/billing", "/settings/password", `/editor/${randomUUID()}`];
for (const path of PRIVATE) {
  for (const [how, headers] of [["page", {}], ["RSC", { RSC: "1", "Next-Router-Prefetch": "1" }]]) {
    const res = await get(path, { headers });
    const label = `${path.replace(/[0-9a-f-]{36}$/, "<id>")} (${how})`;
    const location = res.headers.get("location") ?? "";
    const toLogin = res.status >= 300 && res.status < 400 && /\/login\b/.test(location);
    const denied = [401, 403, 404].includes(res.status);
    const data = privateData(res.text);
    if (data.length) fail(`${label}: HTTP ${res.status} carries ${data.join(", ")}`);
    else if (toLogin) pass(`${label}: ${res.status} to ${new URL(location, SITE).pathname}, no private data`);
    else if (denied) pass(`${label}: HTTP ${res.status}, no private data`);
    else fail(`${label}: HTTP ${res.status}${location ? ` to ${location}` : ""}, not a redirect to /login`);
  }
}
{
  const res = await get("/api/billing/team");
  const data = privateData(res.text);
  if (data.length || res.status === 200) fail(`/api/billing/team: HTTP ${res.status}${data.length ? ` carries ${data.join(", ")}` : " without signing in"}`);
  else pass(`/api/billing/team: HTTP ${res.status}, no private data`);
}

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

/** Tables, views and SECURITY DEFINER functions, from supabase/*.sql when this runs from the repo. */
function appSchema() {
  const files = ["../supabase/schema.sql"].map((f) => new URL(f, import.meta.url)).filter((u) => existsSync(u));
  const sql = files.map((u) => readFileSync(u, "utf8")).join("\n");
  const tables = new Set([...sql.matchAll(/create table if not exists public\.(\w+)/gi)].map((m) => m[1]));
  for (const m of sql.matchAll(/create (?:or replace )?(?:materialized )?view (?:if not exists )?public\.(\w+)/gi)) tables.add(m[1]);
  const functions = new Map();
  for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)\s*returns (\w+)([\s\S]*?)\bas \$\$/gi)) {
    if (m[3].toLowerCase() === "trigger" || !/security definer/i.test(m[4])) continue;
    const params = {};
    for (const part of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [name, type] = part.split(/\s+/);
      params[name] = /uuid/i.test(type) ? "00000000-0000-4000-8000-000000000000" : /int/i.test(type) ? 1 : "day";
    }
    functions.set(m[1], params);
  }
  if (!tables.size) for (const t of ["profiles", "documents", "team_members", "billing_events", "usage_counters"]) tables.add(t);
  if (!functions.size) {
    const uid = { uid: "00000000-0000-4000-8000-000000000000" };
    const usage = { p_key: "x", p_bucket: "x", p_window: "day" };
    for (const [n, p] of [["own_plan", uid], ["effective_plan", uid], ["consume_usage", { ...usage, p_limit: 1 }], ["refund_usage", usage], ["usage_count", usage]]) functions.set(n, p);
  }
  return { tables: [...tables], functions };
}

if (flag("--skip-supabase")) {
  pass("skipped (--skip-supabase)");
} else {
  const sb = publicSupabase();
  if (!sb.key || !sb.url) {
    fail(`couldn't find the Supabase ${sb.key ? "URL" : "public key"} in the site's scripts, so the database wasn't checked (use --supabase-url, or --skip-supabase if the site has no accounts)`);
  } else {
    const headers = { apikey: sb.key, ...(sb.key.startsWith("eyJ") ? { authorization: `Bearer ${sb.key}` } : {}), accept: "application/json" };
    const call = (path, opts = {}) =>
      request(`${sb.url}${path}`, { ...opts, headers: { ...headers, ...(opts.headers ?? {}) } }).catch((err) => ({ status: 0, text: "", error: err }));
    const json = (res) => {
      try {
        return JSON.parse(res.text);
      } catch {
        return null;
      }
    };
    const { tables, functions } = appSchema();
    // Anything else the API lists for the public key.
    const root = await call("/rest/v1/");
    const listed = Object.keys(json(root)?.paths ?? {}).map((p) => p.replace(/^\//, "")).filter((p) => p && !p.startsWith("rpc/"));
    for (const t of listed) if (!tables.includes(t)) tables.push(t);

    await pool(tables, 4, async (t) => {
      const res = await call(`/rest/v1/${encodeURIComponent(t)}?select=*&limit=3`);
      const body = json(res);
      if (res.status === 200 && Array.isArray(body) && body.length) fail(`table ${t}: returns rows to anyone with the public key (${body.length}+)`);
      else if (res.status === 200 && Array.isArray(body)) pass(`table ${t}: no rows`);
      else if ([401, 403].includes(res.status)) pass(`table ${t}: permission denied`);
      else if (res.status === 404) pass(`table ${t}: not exposed`);
      else fail(`table ${t}: couldn't check (HTTP ${res.status}${res.error ? `, ${res.error.message}` : ""})`);
    });
    await pool([...functions], 4, async ([fn, params]) => {
      const res = await call(`/rest/v1/rpc/${encodeURIComponent(fn)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
      const code = json(res)?.code;
      if (res.status >= 200 && res.status < 300) fail(`function ${fn}(): runs for anyone with the public key`);
      else if ([401, 403].includes(res.status) || code === "42501") pass(`function ${fn}(): permission denied`);
      else if (res.status === 404) pass(`function ${fn}(): not exposed`);
      else if (res.status === 0 || res.status >= 500) fail(`function ${fn}(): couldn't check (HTTP ${res.status})`);
      else fail(`function ${fn}(): ran and failed (HTTP ${res.status}${code ? `, ${code}` : ""}), so the public key may call it`);
    });
    {
      const res = await call("/storage/v1/object/list/documents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }) });
      const body = json(res);
      if (res.status === 200 && Array.isArray(body) && body.length) fail(`documents bucket: lists ${body.length} item(s) to anyone with the public key`);
      else if (res.status === 200 || [400, 401, 403, 404].includes(res.status)) pass(`documents bucket: nothing listed (HTTP ${res.status})`);
      else fail(`documents bucket: couldn't check (HTTP ${res.status})`);
    }
    {
      const res = await call("/auth/v1/settings");
      const body = json(res);
      if (body && body.mailer_autoconfirm === true) fail(`Auth: "Confirm email" is off (sign-up then shows which emails have accounts, and team seats rely on confirmed emails)`);
      else if (body && body.mailer_autoconfirm === false) pass(`Auth: "Confirm email" is on`);
      else fail(`Auth settings: couldn't check (HTTP ${res.status})`);
    }
  }
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
console.log(`\n${failed.length ? `FAILED: ${failed.length} of ${results.length} checks` : `All ${results.length} checks passed`}.`);
process.exit(failed.length ? 1 : 0);
