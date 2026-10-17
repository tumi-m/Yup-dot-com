/**
 * Signed out on a protected page, the proxy sends people to log in and back
 * to the same URL, query included: a Paystack return (?ref=…) must still be
 * confirmed after the login.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
const { NextRequest } = await import("next/server");
const { updateSession } = await import("../lib/supabase/middleware.ts");
const { loginHref, safeRedirect } = await import("../components/auth-redirect.ts");

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra: unknown = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? "  — " + JSON.stringify(extra) : ""}`);
};

const REF = "pw_0123456789abcdef01234567";
const back = `/settings/billing?ref=${REF}&trxref=${REF}&reference=${REF}`;
const res = await updateSession(new NextRequest(`http://localhost:3000${back}`));
const to = new URL(res.headers.get("location") ?? "http://x/");
check("signed out on billing → login", res.status === 307 && to.pathname === "/login", res.headers.get("location"));
check("redirect keeps the query", to.searchParams.get("redirect") === back, to.searchParams.get("redirect"));
check("the payment params aren't copied onto /login", [...to.searchParams.keys()].join() === "redirect", to.search);
check("after login the user lands back on the same URL", safeRedirect(to.searchParams.get("redirect")) === back);

const plain = await updateSession(new NextRequest("http://localhost:3000/dashboard"));
check("no query → redirect is just the path", plain.headers.get("location") === "http://localhost:3000/login?redirect=%2Fdashboard",
  plain.headers.get("location"));

const open = await updateSession(new NextRequest("http://localhost:3000/pricing?currency=EUR"));
check("public pages pass through", !open.headers.get("location"));

check("loginHref encodes the path", loginHref(`/settings/billing?ref=${REF}`) === `/login?redirect=%2Fsettings%2Fbilling%3Fref%3D${REF}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
