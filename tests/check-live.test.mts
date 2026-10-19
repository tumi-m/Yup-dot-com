/**
 * scripts/check-live.mjs, offline: a made-up site and a made-up Supabase
 * (PostgREST, Storage, Auth) on localhost, once set up safely and once with
 * the mistakes from the 2026 "vibe-coded site" hacks and the ones a red team
 * found next: a service_role key in a script, a public .env, a dashboard
 * that ships its data before login, a private page reached by adding .png,
 * an RLS-off table, a table any signed-up user can read, an empty table
 * that accepts writes, a callable SECURITY DEFINER function the API lists
 * (and one that writes), a listable or public bucket, missing headers, a
 * route nobody classified and a source map with the code. The checker must
 * pass the first and fail the second on each of those.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "\n" + extra : ""}`);
};

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role: string) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", ref: "fake", role })}.c2lnbmF0dXJlX2Zvcl90ZXN0cw`;
const ANON = jwt("anon");
const SERVICE = jwt("service_role");

type Mode = "safe" | "unsafe";
let mode: Mode = "safe";

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// ---------- Fake Supabase ----------
const UID = "11111111-2222-4333-8444-555555555555";
const USER_TOKEN = jwt("authenticated");
const TEST_ACCOUNT = { CHECK_LIVE_EMAIL: "tester@example.com", CHECK_LIVE_PASSWORD: "a-long-test-password" };
let listing = true;
const supabase = await listen((req, res, body) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload === undefined ? "" : JSON.stringify(payload));
  };
  const denied = (what: string) => send(401, { code: "42501", message: `permission denied for ${what}` });
  if (req.headers.apikey !== ANON) return send(401, { message: "No API key found in request" });
  const user = req.headers.authorization === `Bearer ${USER_TOKEN}`;
  const unsafe = mode === "unsafe";
  const method = req.method ?? "GET";

  if (url.pathname === "/auth/v1/settings") return send(200, { mailer_autoconfirm: unsafe, disable_signup: false });
  if (url.pathname === "/auth/v1/token") {
    const { email, password } = JSON.parse(body || "{}");
    if (email === TEST_ACCOUNT.CHECK_LIVE_EMAIL && password === TEST_ACCOUNT.CHECK_LIVE_PASSWORD) return send(200, { access_token: USER_TOKEN, user: { id: UID, email } });
    return send(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
  }
  if (url.pathname === "/auth/v1/logout") return send(204, undefined);

  // PostgREST lists only what the caller may use.
  if (url.pathname === "/rest/v1/") {
    if (!listing) return send(401, { message: "Access to the schema is restricted" });
    const paths: Record<string, unknown> = { "/": {} };
    const definitions: Record<string, unknown> = {};
    if (user) for (const t of ["profiles", "documents", "team_members", ...(unsafe ? ["customer_notes"] : [])]) paths[`/${t}`] = {};
    if (unsafe && !user) {
      paths["/waitlist"] = {};
      definitions.waitlist = { properties: { id: { format: "integer" }, email: { format: "text" } } };
      paths["/rpc/admin_list_emails"] = { get: { parameters: [] } };
      paths["/rpc/wipe_waitlist"] = { get: { parameters: [{ in: "query", name: "p_note", format: "text" }] } };
    }
    return send(200, { swagger: "2.0", paths, definitions });
  }
  const table = /^\/rest\/v1\/(\w+)$/.exec(url.pathname)?.[1];
  if (table) {
    if (method !== "GET") return unsafe && table === "waitlist" ? send(method === "POST" ? 201 : 204, undefined) : denied(`table ${table}`);
    if (user) {
      if (table === "profiles") return send(200, [{ id: UID, email: "tester@example.com", full_name: "Tester" }]);
      if (table === "documents") return send(200, [{ id: "d1", owner_id: UID, name: "mine.pdf" }]);
      if (table === "team_members") return send(200, []);
      if (unsafe && table === "customer_notes") return send(200, [{ id: 1, email: "victim@corp.co.za", note: "card ending 4242" }]);
      return denied(`table ${table}`);
    }
    if (unsafe && table === "profiles") return send(200, [{ id: "u1", email: "alice@gmail.com", paystack_customer_code: "CUS_abcdefgh12" }]);
    if (unsafe && table === "waitlist") return send(200, []);
    return denied(`table ${table}`);
  }
  const fn = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
  if (fn) {
    if (method !== "GET") return send(500, { message: "the checker must call functions read-only" });
    if (unsafe && fn === "consume_usage") return send(200, 99);
    if (unsafe && fn === "admin_list_emails") return send(200, ["bob@client.co.za"]);
    if (unsafe && fn === "wipe_waitlist") return send(405, { code: "25006", message: "cannot execute DELETE in a read-only transaction" });
    return denied(`function ${fn}`);
  }
  if (url.pathname === "/storage/v1/bucket") return send(200, unsafe ? [{ id: "avatars", name: "avatars", public: true }] : []);
  const list = /^\/storage\/v1\/object\/list\/([\w-]+)$/.exec(url.pathname)?.[1];
  if (list) {
    if (user) return send(200, list === "documents" ? [{ name: UID, id: null }] : []);
    if (unsafe && list === "documents") return send(200, [{ name: "alice/tax-return.pdf" }]);
    if (unsafe && list === "avatars") return send(200, [{ name: "u1/passport-scan.jpg" }]);
    if (unsafe && list === "uploads") return send(200, [{ name: "u2/id-card.jpg" }]);
    return send(200, []);
  }
  const pub = /^\/storage\/v1\/object\/public\/([\w-]+)\//.exec(url.pathname)?.[1];
  if (pub) {
    if (unsafe && (pub === "avatars" || pub === "uploads")) return send(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    return send(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
  }
  send(404, { message: "not found" });
});

// ---------- Fake site ----------
const SAFE_HEADERS = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};
const PAGE_CSP = "script-src 'self' 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
const STATIC_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
const config = () => `let u="${supabase.url}",k="${ANON}";import("/_next/static/chunks/b.js");`;

const site = await listen((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  const safe = mode === "safe";
  const headers = (kind: "page" | "static" | "api") =>
    safe ? { ...SAFE_HEADERS, "content-security-policy": kind === "page" ? PAGE_CSP : STATIC_CSP } : { "x-powered-by": "Next.js" };
  const send = (status: number, type: string, body: string, kind: "page" | "static" | "api" = "page", extra: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": type, ...headers(kind), ...extra });
    res.end(body);
  };
  const html = (body: string) => `<!DOCTYPE html><html><head><script src="/_next/static/chunks/a.js" async></script></head><body>${body}<footer>hello@pdfwizard.xyz</footer></body></html>`;
  if (path === "/_next/static/chunks/a.js") return send(200, "application/javascript", config(), "static");
  if (path === "/_next/static/chunks/b.js") return send(200, "application/javascript", safe ? `console.log("tools")` : `const admin="${SERVICE}";`, "static");
  if (path.endsWith(".js.map")) {
    if (safe) return send(404, "text/plain", "Not found", "static");
    return send(200, "application/json", JSON.stringify({ version: 3, sources: ["lib/supabase/server.ts"], sourcesContent: ["export const x = 1"] }), "static");
  }
  if (path === "/.env" && !safe) return send(200, "text/plain", "SUPABASE_SERVICE_ROLE_KEY=eyJ...", "static");
  if (["/dashboard", "/settings/billing", "/settings/password"].includes(path) || path.startsWith("/editor/")) {
    if (safe) return send(307, "text/plain", "/login", "page", { location: `/login?redirect=${encodeURIComponent(path)}` });
    // The Bootlegger mistake: the data ships with the page, behind a login screen.
    return send(200, "text/html", html(`<form>Log in</form><script>self.__next_f.push(["{\\"email\\":\\"bob@gmail.com\\",\\"paystack_customer_code\\":\\"CUS_bobbob1234\\"}"])</script>`));
  }
  if (path === "/api/billing/team") return send(safe ? 401 : 200, "application/json", safe ? `{"error":"Sign in first."}` : `{"members":["carol@gmail.com"]}`, "api");
  if (path === "/api/billing/verify") return send(safe ? 401 : 200, "application/json", safe ? `{"error":"Sign in first."}` : `{"status":"paid","plan":"pro"}`, "api");
  if (path === "/security.txt") return send(308, "text/plain", "", "static", { location: "/.well-known/security.txt" });
  if (path === "/api/prices") return send(200, "application/json", `{"currency":"ZAR"}`, "api");
  if (path === "/.well-known/security.txt") {
    if (!safe) return send(404, "text/plain", "Not found", "static");
    return send(200, "text/plain", `Contact: mailto:security@pdfwizard.xyz\nExpires: ${new Date(Date.now() + 300 * 864e5).toISOString()}\n`, "static");
  }
  if (["/", "/login", "/signup", "/pricing", "/tools", "/security", "/forgot-password"].includes(path)) return send(200, "text/html", html("<main>PDF Wizard</main>"));
  send(404, "text/html", html("<main>Not found</main>"));
});

// A build's route list with one page nobody put in scripts/routes.mjs.
const manifestDir = mkdtempSync(join(tmpdir(), "check-live-"));
const manifest = join(manifestDir, "app-path-routes-manifest.json");
writeFileSync(manifest, JSON.stringify({ "/page": "/", "/dashboard/page": "/dashboard", "/admin/page": "/admin", "/_not-found/page": "/_not-found" }));

function runChecker(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/check-live.mjs", site.url, ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

mode = "safe";
const safe = await runChecker([], TEST_ACCOUNT);
check("safe site: passes, exit 0", safe.code === 0 && /All \d+ checks passed/.test(safe.out), safe.out);
check("safe site: found the Supabase URL and key in its scripts; reads and writes refused on every table",
  /table profiles: read, insert, update and delete refused/.test(safe.out) && /table documents: read, insert, update and delete refused/.test(safe.out), safe.out);
check("safe site: called the SECURITY DEFINER functions from supabase/schema.sql, read-only",
  /function consume_usage\(\): refused/.test(safe.out) && /function effective_plan\(\): refused/.test(safe.out), safe.out);
check("safe site: every private page redirects to /login, as pages and as RSC, also with .png added",
  /\/dashboard \(RSC\): 307 to \/login/.test(safe.out) && /\/editor\/<id>\.png \(page\): 307 to \/login/.test(safe.out), safe.out);
check("safe site: closed routes refuse a signed-out GET", /closed routes .*: none answers a signed-out GET/.test(safe.out), safe.out);
check("safe site: the bucket in supabase/schema.sql is private", /bucket documents: private, nothing listed/.test(safe.out), safe.out);
check("safe site: signed in, the test account gets only its own rows and folder",
  /table profiles: only the account's own rows \(1\)/.test(safe.out) && /bucket documents: only the account's own folder/.test(safe.out), safe.out);
check("safe site: no warnings when everything could be checked", !/WARN/.test(safe.out), safe.out);

mode = "unsafe";
const bad = await runChecker(["--routes", manifest], TEST_ACCOUNT);
const failed = (re: RegExp) => bad.out.split("\n").some((l) => l.includes("FAIL") && re.test(l));
check("unsafe site: fails, exit 1", bad.code === 1, bad.out);
check("unsafe: a service_role key in a script", failed(/b\.js: a Supabase key with role "service_role"/), bad.out);
check("unsafe: missing security headers and X-Powered-By", failed(/page \/: missing .*X-Content-Type-Options.*Content-Security-Policy.*X-Powered-By/), bad.out);
check("unsafe: a redirect without security headers", failed(/redirect \/security\.txt \(HTTP 308\): missing/), bad.out);
check("unsafe: /.env is served", failed(/\/\.env \(HTTP 200/), bad.out);
check("unsafe: a source map with the code", failed(/source map served/), bad.out);
check("unsafe: the dashboard ships data before login", failed(/\/dashboard \(page\): HTTP 200 carries account fields/), bad.out);
check("unsafe: a private page reached by adding .png", failed(/\/editor\/<id>\.png \(page\): HTTP 200/), bad.out);
check("unsafe: private APIs answer without signing in", failed(/\/api\/billing\/team: HTTP 200/) && failed(/\/api\/billing\/verify: HTTP 200/), bad.out);
check("unsafe: a route the build has that nobody classified", failed(/\/admin: the build has this route but scripts\/routes\.mjs/), bad.out);
check("unsafe: a table with RLS off returns rows", failed(/table profiles: returns rows/), bad.out);
check("unsafe: an empty table the public key may read and write (RT-3)",
  failed(/table waitlist: the public key may read it/) && failed(/table waitlist: accepts inserts/) && failed(/table waitlist: accepts updates/) && failed(/table waitlist: accepts deletes/), bad.out);
check("unsafe: a SECURITY DEFINER function runs for anyone", failed(/function consume_usage\(\): runs for anyone/), bad.out);
check("unsafe: a function only the API's listing names runs for anyone (RT-2)", failed(/function admin_list_emails\(\): runs for anyone/), bad.out);
check("unsafe: a function that writes is caught without letting it write", failed(/function wipe_waitlist\(\): runs for anyone .*nothing changed/), bad.out);
check("unsafe: the documents bucket lists files", failed(/bucket documents: lists 1 item/), bad.out);
check("unsafe: another bucket lists files and is public (RT-4)", failed(/bucket avatars: lists 1 item/) && failed(/bucket avatars: is public/), bad.out);
check("unsafe: a bucket nothing names, found by guessing a common name", failed(/bucket uploads: lists 1 item/) && failed(/bucket uploads: is public/), bad.out);
check("unsafe: a table any signed-up user can read (RT-1)", failed(/table customer_notes: any signed-up user gets 1 row/), bad.out);
check("unsafe: Confirm email is off", failed(/Confirm email" is off/), bad.out);
check("unsafe: no security.txt", failed(/security\.txt: missing/), bad.out);

// The API won't list its schema: a warning that names the fallback, even with --quiet.
mode = "safe";
listing = false;
const nolist = await runChecker(["--quiet"]);
listing = true;
check("no API listing: still passes, with a warning printed even with --quiet",
  nolist.code === 0 && /WARN  Couldn't list the database API with the public key \(HTTP 401\).*supabase\/audit\.sql/.test(nolist.out) && /WARN  No test account/.test(nolist.out), nolist.out);

const wrongPassword = await runChecker(["--quiet"], { ...TEST_ACCOUNT, CHECK_LIVE_PASSWORD: "wrong" });
check("a test account that can't sign in fails the check", wrongPassword.code === 1 && /couldn't sign in the test account/.test(wrongPassword.out), wrongPassword.out);

// --env-values: a server-only value anywhere in what the site sends.
mode = "safe";
const values = await runChecker(["--env-values"], { USAGE_HASH_SALT: "pdfwizard.xyz" });
check("--env-values: a server-only value on a page fails the check", values.code === 1 && /the value of USAGE_HASH_SALT/.test(values.out), values.out);

const usage = await new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn(process.execPath, ["scripts/check-live.mjs", "pdfwizard.xyz"]);
  let out = "";
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ code, out }));
});
check("a missing or bare URL is a usage error (exit 2)", usage.code === 2 && /Usage/.test(usage.out), usage.out);

site.server.close();
supabase.server.close();
rmSync(manifestDir, { recursive: true, force: true });
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
