/**
 * The pages' Content-Security-Policy (lib/csp.ts, set by proxy.ts): only
 * scripts with this response's nonce run, connections go only to this site
 * and the services it uses, and the proxy hands Next.js the nonce.
 * (In Chromium, injected <script>, onerror="" and javascript: links were
 * refused and every tool still ran: see SECURITY.md.)
 */
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import { contentSecurityPolicy, newNonce, type CspSettings } from "../lib/csp.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const prod: CspSettings = { dev: false, supabaseUrl: "https://abc.supabase.co", mediaWorkerUrl: "https://media.example.com/x", analytics: true, turnstile: false };
const csp = contentSecurityPolicy("bm9uY2U=", prod);
const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(name + " ")) ?? "";

check("scripts need this response's nonce", directive("script-src").includes("'nonce-bm9uY2U='") && directive("script-src").includes("'strict-dynamic'"));
check("no inline scripts or eval in production", !/'unsafe-inline'|'unsafe-eval'/.test(csp), csp);
check("WebAssembly can compile (PDF, OCR and video tools)", directive("script-src").includes("'wasm-unsafe-eval'"));
check("connections: this site, Supabase, the media worker and Analytics",
  ["'self'", "https://abc.supabase.co", "wss://abc.supabase.co", "https://media.example.com", "https://*.google-analytics.com"].every((s) => directive("connect-src").split(" ").includes(s)), directive("connect-src"));
check("and nowhere else", !/https:\/\/\*(\s|$)|\shttps:(\s|$)|\*(\s|$)/.test(directive("connect-src")), directive("connect-src"));
{
  const env = process.env as Record<string, string | undefined>;
  const { cspSettings } = await import("../lib/csp.ts");
  env.MEDIA_WORKER_URL = "https://media.example.com";
  delete env.NEXT_PUBLIC_ENABLE_YOUTUBE;
  check("the media worker is named only while YouTube is on", cspSettings().mediaWorkerUrl === undefined);
  env.NEXT_PUBLIC_ENABLE_YOUTUBE = "1";
  check("and is when it is", cspSettings().mediaWorkerUrl === "https://media.example.com");
  delete env.MEDIA_WORKER_URL;
  delete env.NEXT_PUBLIC_ENABLE_YOUTUBE;
}
check("Analytics hosts only when Analytics is on", !contentSecurityPolicy("x", { ...prod, analytics: false }).includes("google"));
check("Turnstile only when it's on", contentSecurityPolicy("x", { ...prod, turnstile: true }).includes("https://challenges.cloudflare.com") && !csp.includes("cloudflare"));
check("no plugins, <base> changes, off-site forms or framing",
  ["object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].every((d) => csp.includes(d)));
check("development allows eval and the reload socket", /'unsafe-eval'/.test(contentSecurityPolicy("x", { ...prod, dev: true })) && contentSecurityPolicy("x", { ...prod, dev: true }).includes(" ws:"));
const a = newNonce(), b = newNonce();
check("a new nonce every time", a !== b && /^[A-Za-z0-9+/=]{24,}$/.test(a), a);

// The proxy: the same nonce in the response's policy and in what Next.js and the layout read.
{
  const { proxy } = await import("../proxy.ts");
  const res = await proxy(new NextRequest("http://localhost/pricing"));
  const policy = res.headers.get("content-security-policy") ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  const forwarded = res.headers.get("x-middleware-request-x-nonce");
  const forwardedPolicy = res.headers.get("x-middleware-request-content-security-policy");
  check("the proxy sets the policy on the page", !!nonce, policy);
  check("and passes the nonce on to Next.js and the layout", forwarded === nonce && forwardedPolicy === policy, `${forwarded} / ${nonce}`);
  const again = (await proxy(new NextRequest("http://localhost/pricing"))).headers.get("content-security-policy");
  check("each response gets its own nonce", again !== policy);
}

// Which paths the proxy sees, compiled the way Next.js compiles the matcher.
// A page path ending in .png used to skip it: no script CSP, no login check.
{
  const { config } = await import("../proxy.ts");
  // In a plain Node process: Next's build helpers don't load next to its server modules.
  const compiled = spawnSync(
    process.execPath,
    ["-e", `const { getMiddlewareMatchers } = require("next/dist/build/analysis/get-page-static-info.js");
            console.log(JSON.stringify(getMiddlewareMatchers(${JSON.stringify(config.matcher)}, { i18n: null }).map((m) => m.regexp)));`],
    { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" }
  );
  const res = (JSON.parse(compiled.stdout || "[]") as string[]).map((r) => new RegExp(r));
  check("the matcher compiles", res.length > 0, compiled.stderr);
  const sees = (path: string) => res.some((re) => re.test(path));
  const pages = ["/", "/pricing", "/editor/3f2a.png", "/edit/x.png", "/tools/merge-pdf.svg", "/dashboard.png", "/security.txt", "/.well-known/security.txt"];
  const assets = ["/_next/static/chunks/app.js", "/_next/image", "/vendor/pdfjs/pdf.worker.min.mjs", "/icon.svg", "/favicon.ico"];
  check("the proxy sees every page, including paths that end in .png or .svg", pages.every(sees), pages.filter((p) => !sees(p)).join(", "));
  check("and skips only Next.js's static files, /vendor and the icon", assets.every((p) => !sees(p)), assets.filter(sees).join(", "));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
