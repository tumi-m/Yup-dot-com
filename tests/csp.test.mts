/**
 * The pages' Content-Security-Policy (lib/csp.ts, set by proxy.ts): only
 * scripts with this response's nonce run, connections go only to this site
 * and the services it uses, and the proxy hands Next.js the nonce.
 * (In Chromium, injected <script>, onerror="" and javascript: links were
 * refused and every tool still ran: see SECURITY.md.)
 */
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

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
