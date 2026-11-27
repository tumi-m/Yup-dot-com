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

// "Log in" in the header went to the dashboard afterwards, from Pricing or a
// tool too, so someone about to pay or mid-task lost their place.
{
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  const { MarketingNav } = await import("../components/MarketingNav.tsx");
  const loginLinks = (pathname: string, props: { loginHref?: string } = {}) => {
    const html = renderToStaticMarkup(createElement(PathnameContext.Provider, { value: pathname }, createElement(MarketingNav, { isAuthed: false, ...props })));
    return [...new Set([...html.matchAll(/href="([^"]*\/login[^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&")))];
  };
  check("Log in on Pricing comes back to Pricing", JSON.stringify(loginLinks("/pricing")) === JSON.stringify([loginHref("/pricing")]), loginLinks("/pricing"));
  check("Log in on a tool comes back to the tool", JSON.stringify(loginLinks("/tools/compress-pdf")) === JSON.stringify([loginHref("/tools/compress-pdf")]), loginLinks("/tools/compress-pdf"));
  check("Log in on the home page goes on to the dashboard", JSON.stringify(loginLinks("/")) === '["/login"]', loginLinks("/"));
  check("not for pages that only start the same", JSON.stringify(loginLinks("/pricingx")) === '["/login"]', loginLinks("/pricingx"));
  check("a page's own loginHref still wins", JSON.stringify(loginLinks("/redeem", { loginHref: loginHref("/redeem") })) === JSON.stringify([loginHref("/redeem")]));
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
