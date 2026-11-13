// Any website could sign a visitor in to someone else's account: a link
// with a token hash (the reset email) works in any browser, and opening
// /auth/callback?token_hash=…&type=recovery, even from another site, used
// it at once and replaced the session cookie. The visitor then saved files
// and payment details into that account. Now the GET only keeps the link in
// a cookie and opens /auth/confirm; Continue there posts it back from this
// site, naming the link the page showed, so a link another site opens while
// yours waits isn't the one used. OAuth codes (tied to the browser that
// asked) still sign in at once.
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
import { readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";

// Supabase Auth, faked: /verify answers account B's session for "hash-B".
const verifyCalls: string[] = [];
const far = Math.floor(Date.now() / 1000) + 3600;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "http://127.0.0.1:54321") return realFetch(input, init);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/auth/v1/verify") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    verifyCalls.push(`${body.type}:${body.token_hash}`);
    if (body.token_hash !== "hash-B") return json(403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
    return json(200, {
      access_token: "access-B", refresh_token: "refresh-B", token_type: "bearer", expires_in: 3600, expires_at: far,
      user: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "b@example.test", aud: "authenticated", role: "authenticated" },
    });
  }
  return json(404, { msg: "not found" });
}) as typeof fetch;

const { GET, POST } = await import("../app/auth/callback/route.ts");
const { handleCallbackGet, handleCallbackPost, PENDING_LINK_COOKIE, LINK_FIELD, encodePendingLink, readPendingLink, linkDigest } = await import("../lib/auth-callback.ts");
const { AUTH_COOKIE_OPTIONS } = await import("../lib/supabase/config.ts");

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const SITE = "http://localhost:3405";
const setCookies = (res: Response) => res.headers.getSetCookie();
const sessionCookies = (res: Response) => setCookies(res).filter((c) => /^sb-[^=]*-auth-token/.test(c));
const attempt = async (what: () => Promise<Response>) => {
  try {
    return await what();
  } catch (err) {
    return err as Error;
  }
};

// A browser signed in as A, with a real Supabase client writing its cookies.
function browser() {
  const jar = new Map<string, string>([["sb-127-auth-token", "base64-" + Buffer.from(JSON.stringify({ access_token: "access-A", refresh_token: "refresh-A", expires_at: far, token_type: "bearer", user: { id: "a" } })).toString("base64url")]]);
  const written: string[] = [];
  const deps = {
    configured: true,
    auth: async () =>
      createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        cookieOptions: AUTH_COOKIE_OPTIONS,
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (list) => list.forEach(({ name, value }) => (jar.set(name, value), written.push(name))),
        },
      }).auth,
  };
  return { jar, written, deps };
}
const holds = (jar: Map<string, string>) => {
  try {
    return JSON.parse(Buffer.from((jar.get("sb-127-auth-token") ?? "").replace(/^base64-/, ""), "base64url").toString()).access_token;
  } catch {
    return null;
  }
};

// The Continue page's form for the link in a waiting-link cookie.
const shownFor = (cookie: string) => {
  const link = readPendingLink(cookie.slice(cookie.indexOf("=") + 1));
  return link ? `${LINK_FIELD}=${linkDigest(link)}` : "";
};
const waiting = (res: Response) => setCookies(res).find((c) => c.startsWith(`${PENDING_LINK_COOKIE}=`))!.split(";")[0];

const LINK = `${SITE}/auth/callback?next=%2Fdashboard&token_hash=hash-B&type=recovery`;
const CROSS = { host: "localhost:3405", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };

// ---------- Another site opens someone else's link in your browser ----------
const opened = await attempt(() => GET(new Request(LINK, { headers: CROSS })));
const openedOk = opened instanceof Response;
check("the link (from another site) doesn't use the token from the GET", openedOk && verifyCalls.length === 0,
  openedOk ? verifyCalls : String(opened));
check("and writes no session cookie", openedOk && sessionCookies(opened).length === 0, openedOk ? setCookies(opened) : "");
const location = openedOk ? new URL(opened.headers.get("location") ?? "", SITE) : null;
check("it opens the Continue page, with the token out of the address", openedOk && opened.status === 303 &&
  location?.pathname === "/auth/confirm" && !location.search, openedOk ? opened.headers.get("location") : "");
const pending = openedOk ? setCookies(opened).find((c) => c.startsWith(`${PENDING_LINK_COOKIE}=`)) ?? "" : "";
check("the link waits in an HttpOnly, SameSite=Lax cookie for /auth only",
  /HttpOnly/i.test(pending) && /SameSite=lax/i.test(pending) && /Path=\/auth(;|$)/.test(pending) && /Max-Age=3600/.test(pending), pending);
const pendingCookie = pending.split(";")[0];
const pendingForm = shownFor(pendingCookie);
// The same link with a real Supabase client on a browser signed in as A, so a
// GET that signed in would show up here whatever it reads cookies from.
const a = browser();
const direct = await handleCallbackGet(new Request(LINK, { headers: CROSS }), a.deps);
check("the GET leaves the browser's session alone", verifyCalls.length === 0 && a.written.length === 0 &&
  holds(a.jar) === "access-A" && sessionCookies(direct).length === 0, { verifyCalls, written: a.written, holds: holds(a.jar) });

const evilForm = { ...CROSS, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: pendingCookie };
const evil = await attempt(() => POST(new Request(`${SITE}/auth/callback`, { method: "POST", headers: evilForm, body: pendingForm })));
check("another site's form posting Continue is refused", evil instanceof Response && evil.status === 403 && setCookies(evil).length === 0,
  evil instanceof Response ? evil.status : String(evil));
const { "sec-fetch-site": _, ...noFetchMeta } = evilForm;
const evil2 = await attempt(() => POST(new Request(`${SITE}/auth/callback`, { method: "POST", headers: noFetchMeta, body: pendingForm })));
check("and without Sec-Fetch-Site, by its Origin", evil2 instanceof Response && evil2.status === 403, evil2 instanceof Response ? evil2.status : String(evil2));
check("neither reached Supabase", verifyCalls.length === 0, verifyCalls);

// ---------- Continue on this site's page ----------
const b = browser();
const same = { host: "localhost:3405", origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" };
const ok = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: `other=1; ${pendingCookie}` }, body: pendingForm }), b.deps);
check("Continue signs in with the link", ok.status === 303 && new URL(ok.headers.get("location")!).pathname === "/dashboard" &&
  verifyCalls.join() === "recovery:hash-B", { status: ok.status, location: ok.headers.get("location"), verifyCalls });
check("and writes that session", holds(b.jar) === "access-B" && b.written.includes("sb-127-auth-token"), holds(b.jar));
check("the waiting link is cleared", setCookies(ok).some((c) => c.startsWith(`${PENDING_LINK_COOKIE}=;`) && /Max-Age=0/.test(c)), setCookies(ok));

const again = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: same, body: "" }), browser().deps);
check("Continue with no waiting link: the login page explains", again.status === 303 &&
  again.headers.get("location") === `${SITE}/login?error=auth` && verifyCalls.length === 1, again.headers.get("location"));

const forged = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: `${PENDING_LINK_COOKIE}=${encodePendingLink({ type: "admin" as "email", token_hash: "hash-B", next: "//evil.example" })}` }, body: "" }), browser().deps);
check("a waiting link of an unknown kind isn't used", forged.headers.get("location") === `${SITE}/login?error=auth` && verifyCalls.length === 1, forged.headers.get("location"));
const offsiteCookie = `${PENDING_LINK_COOKIE}=${encodePendingLink({ type: "signup", token_hash: "hash-B", next: "//evil.example" })}`;
const offsite = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: offsiteCookie }, body: shownFor(offsiteCookie) }), browser().deps);
check("and its next page stays on this site", new URL(offsite.headers.get("location")!).href === `${SITE}/dashboard`, offsite.headers.get("location"));

// A reset link, expired: back to Forgot password, keeping where it was going.
const reset = await handleCallbackGet(new Request(`${SITE}/auth/callback?next=${encodeURIComponent("/settings/password?redirect=%2Fpricing")}&token_hash=old&type=recovery`), browser().deps);
const resetCookie = waiting(reset);
const expired = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: resetCookie }, body: shownFor(resetCookie) }), browser().deps);
check("an expired reset link goes to the login page's reset message", expired.headers.get("location") ===
  `${SITE}/login?error=auth&redirect=${encodeURIComponent("/settings/password?redirect=%2Fpricing")}`, expired.headers.get("location"));
const fresh = await handleCallbackGet(new Request(`${SITE}/auth/callback?next=${encodeURIComponent("/settings/password")}&token_hash=hash-B&type=recovery`), browser().deps);
const freshCookie = waiting(fresh);
const resetOk = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: freshCookie }, body: shownFor(freshCookie) }), browser().deps);
check("a good reset link opens the new password page", resetOk.headers.get("location") === `${SITE}/settings/password`, resetOk.headers.get("location"));

// ---------- Another site opens its link while yours waits ----------
// Your own reset link (hash-A) shows its Continue page; before you press it,
// another site opens account B's link in a new window, replacing the cookie.
const mine = waiting(await handleCallbackGet(new Request(`${SITE}/auth/callback?next=%2Fsettings%2Fpassword&token_hash=hash-A&type=recovery`, { headers: CROSS }), browser().deps));
const theirs = waiting(await handleCallbackGet(new Request(`${SITE}/auth/callback?next=%2Fdashboard&token_hash=hash-B&type=magiclink`, { headers: CROSS }), browser().deps));
const used = verifyCalls.length;
const v = browser();
const swapped = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: theirs }, body: shownFor(mine) }), v.deps);
check("Continue on your link's page doesn't use a link opened since", verifyCalls.length === used && holds(v.jar) === "access-A" &&
  swapped.headers.get("location") === `${SITE}/login?error=auth`, { verifyCalls: verifyCalls.slice(used), location: swapped.headers.get("location") });
check("and that link is cleared", setCookies(swapped).some((c) => c.startsWith(`${PENDING_LINK_COOKIE}=;`) && /Max-Age=0/.test(c)), setCookies(swapped));
const bare = await handleCallbackPost(new Request(`${SITE}/auth/callback`, { method: "POST", headers: { ...same, cookie: theirs }, body: "" }), browser().deps);
check("Continue without the page's field isn't used either", verifyCalls.length === used && bare.headers.get("location") === `${SITE}/login?error=auth`, bare.headers.get("location"));

// ---------- OAuth codes are unchanged ----------
const codes: string[] = [];
const oauth = { configured: true, auth: async () => ({ exchangeCodeForSession: async (c: string) => (codes.push(c), { error: null }), verifyOtp: async () => ({ error: "unused" }) }) };
const code = await handleCallbackGet(new Request(`${SITE}/auth/callback?code=abc&next=%2Fpricing`), oauth);
check("an OAuth code still signs in from the link", codes.join() === "abc" && code.status === 307 && code.headers.get("location") === `${SITE}/pricing`, code.headers.get("location"));
const none = await handleCallbackGet(new Request(`${SITE}/auth/callback?next=%2Fpricing`), oauth);
check("no code, no token: the login page", none.headers.get("location") === `${SITE}/login?error=auth&redirect=%2Fpricing`, none.headers.get("location"));

// ---------- The Continue page ----------
const page = readFileSync(new URL("../app/auth/confirm/page.tsx", import.meta.url), "utf8");
check("Continue is a plain form post back to /auth/callback", /<form method="post" action="\/auth\/callback"/.test(page) && /type="submit"/.test(page));
check("naming the link it shows", /<input type="hidden" name=\{LINK_FIELD\} value=\{linkDigest\(link\)\} \/>/.test(page));
check("which nothing submits by itself", !/<script|requestSubmit|\.submit\(|useEffect|"use client"/.test(page));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll email link checks passed.");
