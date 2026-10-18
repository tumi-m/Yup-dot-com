// Password reset, round two:
// - The reset link only worked in the browser that asked for it (its code
//   needs a cookie that browser keeps), so one opened in a phone's mail app
//   always failed. A link with a token hash now signs in anywhere.
// - "Forgot password?" dropped ?redirect, so a log-in that started on
//   Pricing or a payment return ended on "Go to your documents".
// - Supabase's "email rate limit exceeded" was shown as it came.
import { AuthApiError } from "@supabase/supabase-js";
import {
  authErrorMessage,
  authFailure,
  authSwitchHref,
  linkSignIn,
  NEW_PASSWORD_PATH,
  newPasswordPath,
  resetLinkTarget,
  safeRedirect,
} from "../components/auth-redirect.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

// The reset email, as the README's template writes it: the app's address,
// then the token hash.
const target = resetLinkTarget("https://pdfwizard.test", "/settings/billing?ref=PW_123&trxref=PW_123");
const email = new URL(`${target}&token_hash=pkce_abc123&type=recovery`);
const signIn = linkSignIn(email.searchParams);
check("a reset link with a token hash signs in without the asking browser's cookie",
  JSON.stringify(signIn) === JSON.stringify({ type: "recovery", token_hash: "pkce_abc123" }), signIn);
check("a link with a code still signs in the old way", JSON.stringify(linkSignIn(new URLSearchParams("code=abc"))) === '{"code":"abc"}');
check("a token hash of an unknown kind is not used", linkSignIn(new URLSearchParams("token_hash=x&type=admin")) === null);
check("no code, no token: no sign-in", linkSignIn(new URLSearchParams("next=/pricing")) === null);

// Where the link goes, and on from there.
const next = safeRedirect(email.searchParams.get("next"), "");
check("the link opens the new password page", next.split("?")[0] === NEW_PASSWORD_PATH, next);
const back = new URL(next, "https://pdfwizard.test").searchParams.get("redirect");
check("which knows where logging in started, payment reference and all", back === "/settings/billing?ref=PW_123&trxref=PW_123", back);
check("without a redirect, just the new password page", resetLinkTarget("https://pdfwizard.test") === `https://pdfwizard.test/auth/callback?next=${encodeURIComponent(NEW_PASSWORD_PATH)}`);
check("asking again after a link failed doesn't nest the page in itself",
  newPasswordPath(`${NEW_PASSWORD_PATH}?redirect=%2Fpricing`) === `${NEW_PASSWORD_PATH}?redirect=%2Fpricing`);

// The links between the pages keep ?redirect.
check("Forgot password? keeps ?redirect", authSwitchHref("/forgot-password", "?redirect=%2Fpricing") === "/forgot-password?redirect=%2Fpricing");
check("and doesn't take one to another site", authSwitchHref("/forgot-password", "?redirect=%2F%2Fevil.example") === "/forgot-password");
const failedLink = authErrorMessage(`?error=auth&redirect=${encodeURIComponent(newPasswordPath("/pricing"))}`);
check("a failed reset link that knew where to go back still says to ask again", !!failedLink && /Forgot password/.test(failedLink), failedLink);

// Rate limits.
const tooMany = authFailure(new AuthApiError("email rate limit exceeded", 429, "over_email_send_rate_limit"));
check("too many emails: says what to do, in plain words", /^Too many emails/.test(tooMany) && /try again/.test(tooMany), tooMany);
const wait = "For security purposes, you can only request this after 47 seconds.";
check("the wait for one address is kept as it is", authFailure(new AuthApiError(wait, 429, "over_email_send_rate_limit")) === wait);
check("other errors are kept", authFailure(new AuthApiError("Invalid login credentials", 400, "invalid_credentials")) === "Invalid login credentials");
check("something that isn't an error", authFailure("nope") === "Something went wrong.");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll reset link checks passed.");
