/**
 * Another website's page can't spend a guest's allowances (lib/cross-site.ts):
 * the real route handlers refuse cross-site requests and non-JSON bodies, and
 * still serve the site's own.
 */
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.test";
// One proxy in front, so each request's X-Forwarded-For is the visitor's
// address (lib/usage.ts clientIp).
process.env.TRUSTED_PROXY_HOPS = "1";
import { createRequire } from "node:module";
import { refuseCrossSite } from "../lib/cross-site.ts";

// The routes load lib/usage.ts through require(); so must this test, or it
// would get a second copy whose store the routes never see.
const { memoryUsageStore, setUsageStore } = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra ? "  — " + extra : ""}`);
};

const JSON_TYPE = { "content-type": "application/json" };
const req = (headers: Record<string, string>, method = "POST", url = "http://localhost:3202/api/x") =>
  new Request(url, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
const refused = (r: Request, json?: boolean) => refuseCrossSite(r, { json })?.status === 403;

// The check itself.
{
  check("same-origin JSON passes", !refused(req({ ...JSON_TYPE, origin: "http://localhost:3202", "sec-fetch-site": "same-origin" })));
  check("no Origin (server or old client) with JSON passes", !refused(req(JSON_TYPE)));
  check("Sec-Fetch-Site cross-site is refused", refused(req({ ...JSON_TYPE, "sec-fetch-site": "cross-site" })));
  check("another site's Origin is refused", refused(req({ ...JSON_TYPE, origin: "https://evil.example" })));
  check("a subdomain's Origin is refused", refused(req({ ...JSON_TYPE, origin: "http://evil.localhost:3202" })));
  check('Origin "null" (sandboxed frame) is refused', refused(req({ ...JSON_TYPE, origin: "null" })));
  check("a text/plain body is refused (it needs no preflight)", refused(req({ "content-type": "text/plain;charset=UTF-8" })));
  check("a form body is refused", refused(req({ "content-type": "application/x-www-form-urlencoded" })));
  check("JSON with a charset passes", !refused(req({ "content-type": "application/json; charset=utf-8" })));
  check("behind a proxy, X-Forwarded-Host is this site",
    !refused(req({ ...JSON_TYPE, origin: "https://pdf.example", host: "internal:3000", "x-forwarded-host": "pdf.example" })));
  check("the configured site URL passes (a Codespace's forwarded port)",
    !refused(req({ ...JSON_TYPE, origin: "https://pdfwizard.test", "x-forwarded-host": "localhost:3000" })));
  check("a GET without a body passes when bodies aren't checked", !refused(req({ "sec-fetch-site": "same-origin" }, "GET"), false));
  check("a cross-site GET is refused when bodies aren't checked", refused(req({ "sec-fetch-site": "cross-site" }, "GET"), false));
}

// The free edit: a cross-site no-cors POST used to spend it.
{
  setUsageStore(memoryUsageStore());
  const edit = await import("../app/api/usage/edit/route.ts");
  const ip = { "x-forwarded-for": "192.0.2.55" };
  const save = (headers: Record<string, string>, doc: string) =>
    edit.POST(new Request("http://localhost/api/usage/edit", { method: "POST", headers: { ...ip, ...headers }, body: JSON.stringify({ doc }) }));
  const evil = await save({ "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example", "sec-fetch-site": "cross-site" }, "c".repeat(64));
  check("a cross-site page can't spend the free edit", evil.status === 403, String(evil.status));
  const sneaky = await save({ "content-type": "text/plain;charset=UTF-8" }, "c".repeat(64));
  check("nor can a text/plain body without Origin", sneaky.status === 403, String(sneaky.status));
  const own = await save({ ...JSON_TYPE, origin: "http://localhost", "sec-fetch-site": "same-origin" }, "d".repeat(64));
  check("the visitor's own save still gets today's edit", own.status === 200 && (await own.json()).allowed === true, String(own.status));
}

// Every other route that spends an allowance or changes an account.
{
  const evil = { ...JSON_TYPE, origin: "https://evil.example", "sec-fetch-site": "cross-site", "x-forwarded-for": "192.0.2.56" };
  const post = (url: string) => new Request(`http://localhost${url}`, { method: "POST", headers: evil, body: "{}" });
  const routes: [string, () => Promise<Response>][] = [
    ["AI answers", async () => (await import("../app/api/ai/chat/route.ts")).POST(post("/api/ai/chat"))],
    ["download links", async () => (await import("../app/api/media/link/route.ts")).POST(post("/api/media/link"))],
    ["download refunds", async () => (await import("../app/api/media/refund/route.ts")).POST(post("/api/media/refund"))],
    ["link previews", async () => (await import("../app/api/media/info/route.ts")).POST(post("/api/media/info"))],
    ["playlist lists", async () => (await import("../app/api/media/playlist/route.ts")).POST(post("/api/media/playlist"))],
    ["slide imports", async () => (await import("../app/api/slides/export/route.ts")).GET(
      new Request("http://localhost/api/slides/export?url=x&format=pdf", { headers: { "sec-fetch-site": "cross-site" } }))],
    ["checkout", async () => (await import("../app/api/billing/checkout/route.ts")).POST(post("/api/billing/checkout"))],
    ["subscription settings", async () => (await import("../app/api/billing/manage/route.ts")).POST(post("/api/billing/manage"))],
    ["team seats (add)", async () => (await import("../app/api/billing/team/route.ts")).POST(post("/api/billing/team"))],
    ["team seats (remove)", async () => (await import("../app/api/billing/team/route.ts")).DELETE(
      new Request("http://localhost/api/billing/team", { method: "DELETE", headers: evil, body: "{}" }))],
  ];
  for (const [name, call] of routes) {
    const res = await call();
    check(`${name}: cross-site refused`, res.status === 403, String(res.status));
  }
}

// Link previews make the server call X, TikTok or Instagram: a few a minute
// per visitor, so the site can't be used as a free lookup service.
{
  setUsageStore(memoryUsageStore());
  const { MEDIA_LOOKUPS_PER_MINUTE } = createRequire(import.meta.url)("../lib/usage.ts") as typeof import("../lib/usage.ts");
  const info = await import("../app/api/media/info/route.ts");
  const ask = (ip: string) =>
    info.POST(new Request("http://localhost/api/media/info", {
      method: "POST",
      headers: { ...JSON_TYPE, origin: "http://localhost", "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
      body: JSON.stringify({ url: "https://x.com/someone/status/1234567890" }),
    }));
  // X answers nothing useful; each lookup still costs the server a call.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => (calls++, new Response("", { status: 404 }))) as typeof fetch;
  const statuses: number[] = [];
  for (let i = 0; i < MEDIA_LOOKUPS_PER_MINUTE; i++) statuses.push((await ask("192.0.2.77")).status);
  const callsBefore = calls;
  statuses.push((await ask("192.0.2.77")).status);
  check(`link previews: ${MEDIA_LOOKUPS_PER_MINUTE} a minute, then 429 without calling out`,
    statuses.slice(0, -1).every((s) => s !== 429) && statuses.at(-1) === 429 && callsBefore > 0 && calls === callsBefore, statuses.join(","));
  check("another visitor still gets theirs", (await ask("192.0.2.78")).status !== 429);
  globalThis.fetch = realFetch;
}

setUsageStore(null);
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
