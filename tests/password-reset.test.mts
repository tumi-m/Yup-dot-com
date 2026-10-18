/**
 * There was no way back in after forgetting a password. Now /login links to
 * /forgot-password, which emails a reset link; the link signs in through
 * /auth/callback and opens /settings/password to choose a new one.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
import { existsSync, readFileSync } from "node:fs";
const { NextRequest } = await import("next/server");
const { updateSession } = await import("../lib/supabase/middleware.ts");
const { authErrorMessage, NEW_PASSWORD_PATH, resetLinkTarget, safeRedirect } = await import("../components/auth-redirect.ts");

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The link in the email.
const target = new URL(resetLinkTarget("https://pdfwizard.test"));
check("the reset link goes through /auth/callback on this site",
  target.origin === "https://pdfwizard.test" && target.pathname === "/auth/callback", target.href);
check("and on to the new password page", safeRedirect(target.searchParams.get("next"), "") === NEW_PASSWORD_PATH,
  target.searchParams.get("next"));

// The pages exist and are wired up.
check("/forgot-password asks for the email", existsSync(new URL("../app/forgot-password/page.tsx", import.meta.url)) &&
  /<AuthForm mode="reset" \/>/.test(read("app/forgot-password/page.tsx")));
const form = read("components/AuthForm.tsx");
check("the form sends the reset email to that link",
  /resetPasswordForEmail\(email, \{\s*redirectTo: resetLinkTarget\(window\.location\.origin[,)]/.test(form));
check("the login page links to it", /href=\{forgotHref\}/.test(form) && /authSwitchHref\("\/forgot-password"/.test(form) && /Forgot password\?/.test(form));
check("the new password page saves it", /auth\.updateUser\(\{ password \}\)/.test(read("components/PasswordForm.tsx")) &&
  existsSync(new URL("../app/settings/password/page.tsx", import.meta.url)));

// Signed out, the new password page asks to log in first and comes back.
const res = await updateSession(new NextRequest(`http://localhost:3000${NEW_PASSWORD_PATH}`));
check("signed out → login, then back", res.headers.get("location") === "http://localhost:3000/login?redirect=%2Fsettings%2Fpassword",
  res.headers.get("location"));

// A reset link that fails says what to do.
const m = authErrorMessage(`?error=auth&redirect=${encodeURIComponent(NEW_PASSWORD_PATH)}`);
check("an expired reset link points to Forgot password", !!m && /expired/.test(m) && /Forgot password/.test(m), m);
const signup = authErrorMessage("?error=auth&redirect=/pricing");
check("a sign-up link keeps its own message", !!signup && /sign up again/.test(signup), signup);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll password reset checks passed.");
