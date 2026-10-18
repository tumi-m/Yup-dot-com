/**
 * scripts/check-live.mjs, offline: a made-up site and a made-up Supabase
 * (PostgREST, Storage, Auth) on localhost, once set up safely and once with
 * the mistakes from the 2026 "vibe-coded site" hacks: a service_role key in
 * a script, a public .env, a dashboard that ships its data before login, an
 * RLS-off table, a callable SECURITY DEFINER function, a listable bucket,
 * missing headers and a source map with the code. The checker must pass the
 * first and fail the second on each of those.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
const supabase = await listen((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.headers.apikey !== ANON) return send(401, { message: "No API key found in request" });
  if (url.pathname === "/rest/v1/") return send(200, { paths: { "/": {}, "/profiles": {}, "/rpc/own_plan": {} } });
  const table = /^\/rest\/v1\/(\w+)$/.exec(url.pathname)?.[1];
  if (table) {
    if (mode === "unsafe" && table === "profiles") return send(200, [{ id: "u1", email: "alice@gmail.com", paystack_customer_code: "CUS_abcdefgh12" }]);
    if (table === "documents" || table === "billing_events") return send(401, { code: "42501", message: `permission denied for table ${table}` });
    return send(200, []);
  }
  const fn = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname)?.[1];
  if (fn) {
    if (mode === "unsafe" && fn === "consume_usage") return send(200, 99);
    return send(401, { code: "42501", message: `permission denied for function ${fn}` });
  }
  if (url.pathname === "/storage/v1/object/list/documents") return send(200, mode === "unsafe" ? [{ name: "alice/tax-return.pdf" }] : []);
  if (url.pathname === "/auth/v1/settings") return send(200, { mailer_autoconfirm: mode === "unsafe", disable_signup: false });
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
  if (path === "/api/prices") return send(200, "application/json", `{"currency":"ZAR"}`, "api");
  if (path === "/.well-known/security.txt") {
    if (!safe) return send(404, "text/plain", "Not found", "static");
    return send(200, "text/plain", `Contact: mailto:security@pdfwizard.xyz\nExpires: ${new Date(Date.now() + 300 * 864e5).toISOString()}\n`, "static");
  }
  if (["/", "/login", "/signup", "/pricing", "/tools", "/security", "/forgot-password"].includes(path)) return send(200, "text/html", html("<main>PDF Wizard</main>"));
  send(404, "text/html", html("<main>Not found</main>"));
});

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
const safe = await runChecker([]);
check("safe site: passes, exit 0", safe.code === 0 && /All \d+ checks passed/.test(safe.out), safe.out);
check("safe site: found the Supabase URL and key in its scripts and checked the tables", /table profiles: no rows/.test(safe.out) && /table documents: permission denied/.test(safe.out), safe.out);
check("safe site: called the SECURITY DEFINER functions from supabase/schema.sql", /function consume_usage\(\): permission denied/.test(safe.out) && /function effective_plan\(\): permission denied/.test(safe.out), safe.out);
check("safe site: private pages redirect to /login, as pages and as RSC", /\/dashboard \(RSC\): 307 to \/login/.test(safe.out), safe.out);

mode = "unsafe";
const bad = await runChecker([]);
const failed = (re: RegExp) => bad.out.split("\n").some((l) => l.includes("FAIL") && re.test(l));
check("unsafe site: fails, exit 1", bad.code === 1, bad.out);
check("unsafe: a service_role key in a script", failed(/b\.js: a Supabase key with role "service_role"/), bad.out);
check("unsafe: missing security headers and X-Powered-By", failed(/page \/: missing .*X-Content-Type-Options.*Content-Security-Policy.*X-Powered-By/), bad.out);
check("unsafe: /.env is served", failed(/\/\.env \(HTTP 200/), bad.out);
check("unsafe: a source map with the code", failed(/source map served/), bad.out);
check("unsafe: the dashboard ships data before login", failed(/\/dashboard \(page\): HTTP 200 carries account fields/), bad.out);
check("unsafe: a private API answers without signing in", failed(/\/api\/billing\/team: HTTP 200/), bad.out);
check("unsafe: a table with RLS off returns rows", failed(/table profiles: returns rows/), bad.out);
check("unsafe: a SECURITY DEFINER function runs for anyone", failed(/function consume_usage\(\): runs for anyone/), bad.out);
check("unsafe: the documents bucket lists files", failed(/documents bucket: lists 1 item/), bad.out);
check("unsafe: Confirm email is off", failed(/Confirm email" is off/), bad.out);
check("unsafe: no security.txt", failed(/security\.txt: missing/), bad.out);

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
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
