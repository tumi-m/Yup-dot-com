/**
 * Links between the auth pages keep where the user was going, and a failed
 * confirmation link is explained.
 */
import { authErrorMessage, authSwitchHref, safeRedirect } from "../components/auth-redirect.ts";

const results: boolean[] = [];
const check = (name: string, ok: boolean, extra: unknown = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== "" ? "  — " + JSON.stringify(extra) : ""}`);
};

// Log in ↔ Sign up keep ?redirect.
{
  const a = authSwitchHref("/login", "?redirect=/pricing");
  check("signup?redirect=/pricing → Log in keeps it", a === "/login?redirect=%2Fpricing", a);
  const b = authSwitchHref("/signup", "?redirect=/settings/billing");
  check("login?redirect=/settings/billing → Sign up keeps it", b === "/signup?redirect=%2Fsettings%2Fbilling", b);
  const c = authSwitchHref("/login", "?redirect=" + encodeURIComponent("/tools/chat-with-pdf?handoff=1"));
  check("a redirect with its own query survives the round trip",
    safeRedirect(new URLSearchParams(c.split("?")[1]).get("redirect")) === "/tools/chat-with-pdf?handoff=1", c);
  check("no redirect → plain link", authSwitchHref("/signup", "") === "/signup" && authSwitchHref("/login", "?x=1") === "/login");
  check("unsafe redirect dropped", authSwitchHref("/login", "?redirect=//evil.com") === "/login" &&
    authSwitchHref("/login", "?redirect=https://evil.com") === "/login");
}

// /login?error=auth says what happened.
{
  const m = authErrorMessage("?error=auth&redirect=/pricing");
  check("error=auth explains the link", !!m && /expired/.test(m) && /another browser/.test(m), m);
  check("no error, no message", authErrorMessage("") === null && authErrorMessage("?redirect=/pricing") === null);
  check("unknown error codes say nothing", authErrorMessage("?error=<script>") === null);
}

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
