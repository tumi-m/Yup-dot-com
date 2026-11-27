// Sign out left the browser signed in when Supabase couldn't end the
// session: supabase-js clears its cookies only after the server agrees, so
// a 500, a dropped connection or no answer kept them, and the next person
// on a shared computer was in the account once Supabase came back. The
// cookies now go whatever Supabase says, and sign-out doesn't wait forever.
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.test";
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
import { createServerClient } from "@supabase/ssr";

// Supabase Auth, faked: /logout answers as `logout` says.
let logout: "ok" | "500" | "down" | "hang" = "ok";
const logoutCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "http://127.0.0.1:54321") return realFetch(input, init);
  if (url.pathname === "/auth/v1/logout") {
    logoutCalls.push(logout);
    if (logout === "down") throw new TypeError("fetch failed");
    if (logout === "hang") return new Promise<Response>(() => {});
    if (logout === "500") {
      return new Response(JSON.stringify({ code: 500, error_code: "unexpected_failure", msg: "Unexpected failure" }), { status: 500, headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: 204 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// supabase-js and sign-out log each failure: not this test's output.
console.error = () => {};

const { handleSignOut, sessionCookieNames } = await import("../lib/sign-out.ts");
const { AUTH_COOKIE_OPTIONS } = await import("../lib/supabase/config.ts");

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const far = Math.floor(Date.now() / 1000) + 3600;
const session = "base64-" + Buffer.from(JSON.stringify({ access_token: "access-A", refresh_token: "refresh-A", expires_at: far, token_type: "bearer", user: { id: "a" } })).toString("base64url");
// A long session is split over .0 and .1 cookies.
const COOKIE = `pdfw-consent=1; sb-127-auth-token.0=${session.slice(0, 40)}; sb-127-auth-token.1=${session.slice(40)}; pw-email-link=x`;

/** Signs out a browser holding COOKIE, with a real Supabase client reading it. */
async function signOut(waitMs?: number) {
  const jar = new Map<string, string>(COOKIE.split("; ").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  const auth = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  }).auth;
  const started = Date.now();
  const res = await handleSignOut(
    new Request("http://localhost:3405/auth/signout", {
      method: "POST",
      headers: { host: "localhost:3405", origin: "http://localhost:3405", "content-type": "application/x-www-form-urlencoded", cookie: COOKIE },
    }),
    { configured: true, signOut: () => auth.signOut(), waitMs }
  );
  const cleared = res.headers.getSetCookie().filter((c) => /Expires=Thu, 01 Jan 1970/i.test(c) && /Path=\/(;|$)/.test(c)).map((c) => c.slice(0, c.indexOf("=")));
  return { res, cleared, ms: Date.now() - started };
}

check("finds the session cookies, parts and all, and nothing else",
  JSON.stringify(sessionCookieNames(COOKIE + "; sb-127-auth-token-code-verifier=v; sb-other=1; xsb-1-auth-token=1")) ===
    JSON.stringify(["sb-127-auth-token.0", "sb-127-auth-token.1", "sb-127-auth-token-code-verifier"]),
  sessionCookieNames(COOKIE));

for (const mode of ["ok", "500", "down"] as const) {
  logout = mode;
  const { res, cleared } = await signOut();
  check(`Supabase ${mode === "ok" ? "ends the session" : mode === "500" ? "answers 500" : "can't be reached"}: both session cookies are cleared`,
    res.status === 303 && cleared.includes("sb-127-auth-token.0") && cleared.includes("sb-127-auth-token.1"), cleared);
  check(`…and only those (${mode})`, !cleared.includes("pdfw-consent") && !cleared.includes("pw-email-link"), cleared);
}
check("Supabase was asked each time (it ends the session on every device when it can)", logoutCalls.length === 3, logoutCalls);

logout = "hang";
const hung = await signOut(200);
check("Supabase doesn't answer: sign-out goes on after the wait, signed out here",
  hung.res.status === 303 && hung.ms < 2000 && hung.cleared.includes("sb-127-auth-token.0"), { ms: hung.ms, cleared: hung.cleared });
check("and back to the home page", new URL(hung.res.headers.get("location") ?? "").pathname === "/");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sign-out session checks passed.");
process.exit(0);
