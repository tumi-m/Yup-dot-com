import type { EmailOtpType } from "@supabase/supabase-js";

/**
 * Where to go after logging in, from a `?redirect=` value. Only same-site
 * paths are allowed, so the login page can't be used to bounce people to
 * another site.
 */
export function safeRedirect(value: string | null | undefined, fallback = "/dashboard"): string {
  if (!value) return fallback;
  const v = value.trim();
  // A single leading slash, not "//host" or "/\host" (both leave the site).
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  // No control characters (browsers strip tabs and newlines, which can turn
  // "/\t/evil.com" into "//evil.com").
  if (/[\u0000-\u001f\u007f]/.test(v)) return fallback;
  return v;
}

/** The link to another auth page ("/login" ↔ "/signup", Forgot password), keeping ?redirect. */
export function authSwitchHref(target: "/login" | "/signup" | "/forgot-password", search: string): string {
  const redirect = safeRedirect(new URLSearchParams(search).get("redirect"), "");
  return redirect ? `${target}?redirect=${encodeURIComponent(redirect)}` : target;
}

/** Where a password reset link signs people in, to choose a new password. */
export const NEW_PASSWORD_PATH = "/settings/password";

const isNewPasswordPath = (path: string) => path.split("?")[0] === NEW_PASSWORD_PATH;

/** NEW_PASSWORD_PATH, linking on to `back` (where logging in started) once the password is saved. */
export function newPasswordPath(back = ""): string {
  // After a reset link that failed, `back` is already the new password page.
  if (!back || isNewPasswordPath(back)) return back || NEW_PASSWORD_PATH;
  return `${NEW_PASSWORD_PATH}?redirect=${encodeURIComponent(back)}`;
}

/** The address in the reset email: /auth/callback signs in, then on to the new password page. */
export function resetLinkTarget(origin: string, back = ""): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(newPasswordPath(back))}`;
}

/** What to say on /login?error=auth, after a confirmation or reset link fails. */
export function authErrorMessage(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("error") !== "auth") return null;
  return isNewPasswordPath(params.get("redirect") ?? "")
    ? "That reset link has expired or was opened in another browser. Ask for a new one under Forgot password."
    : "That link has expired or was opened in another browser. Log in, or sign up again to get a new link.";
}

/** New passwords: at least this long (sign-up and the new password page). Supabase Auth should match it. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Under new password fields. The README has Supabase Auth require letters
 * and digits too, so the hint says so before Supabase refuses one without.
 */
export const PASSWORD_HINT = `At least ${MIN_PASSWORD_LENGTH} characters, with letters and numbers.`;

export type AuthMode = "login" | "signup" | "reset";

/**
 * The auth forms' submit button. Only a deployment without Supabase disables
 * it outright. While a request runs, or the security check has no token yet
 * (it starts again after every answer), it is aria-disabled and a press does
 * nothing: a disabled button drops the focus it has, and keyboard users were
 * back at the top of the page after each answer.
 */
export function submitState(s: { configured: boolean; loading: boolean; captcha: boolean; token: string | null }) {
  const waiting = s.loading || (s.captcha && !s.token);
  return { disabled: !s.configured, ariaDisabled: waiting, blocked: !s.configured || waiting };
}

const RATE_LIMIT_SITE = /email rate limit/i;

/** Supabase couldn't be reached, or what answered wasn't Supabase (supabase-js names these), or the browser's own fetch failed. */
function unreachable(err: Error): boolean {
  return err.name === "AuthRetryableFetchError" || err.name === "AuthUnknownError" || /^(Failed to fetch|Load failed|NetworkError)/i.test(err.message);
}

/** Refusals Supabase makes from the request alone, before it looks the email up: they say nothing about the account. */
const BEFORE_LOOKUP = new Set([
  "captcha_failed",
  "validation_failed",
  "email_address_invalid",
  "email_address_not_authorized",
  "signup_disabled",
  "email_provider_disabled",
  "weak_password",
  "over_request_rate_limit",
]);

/**
 * Supabase answers that would tell whether an email has an account. "Forgot
 * password" for an unknown email always succeeds at once, without sending
 * anything; only a known one can meet a wait between emails, the project's
 * email limit or a failing mail server. Sign-up gives a confirmed account
 * the usual answer, and only a new or unconfirmed one sends an email (and
 * says "User already registered" when email confirmation is off). So on
 * those two forms anything else Supabase answered gets the form's usual
 * message: only refusals made before the lookup, and a connection that
 * failed, are said.
 */
export function revealsAccount(err: unknown, mode: AuthMode): boolean {
  if (!(err instanceof Error) || mode === "login") return false;
  const { code } = err as { status?: number; code?: string };
  if (mode === "signup" && (code === "user_already_exists" || /already registered/i.test(err.message))) return true;
  // Only a request that never got an answer is said as such: a gateway's
  // error page or a timeout while a real account's email was sent is an
  // answer too, and would tell.
  return !noAnswer(err) && !BEFORE_LOOKUP.has(code ?? "");
}

/** The request got no answer at all: the browser's fetch failed (supabase-js gives status 0). */
function noAnswer(err: Error): boolean {
  const { status } = err as { status?: number };
  return (err.name === "AuthRetryableFetchError" && !status) || /^(Failed to fetch|Load failed|NetworkError)/i.test(err.message);
}

const PASSWORD_RULE = `Use ${PASSWORD_HINT.charAt(0).toLowerCase()}${PASSWORD_HINT.slice(1)}`;

/**
 * What to say when Supabase turns a request down, or can't be reached. Its
 * own words are jargon ("Failed to fetch", "captcha protection: request
 * disallowed (timeout-or-duplicate)", "at least one character of each:
 * abcdefghijklmnopqrstuvwxyzABCD…", which overflowed the form on a phone),
 * so only answers it is known to give are said, each in plain words, and
 * anything else gets a plain sentence. Logging in, a wrong password and an
 * unconfirmed email get the same answer, so it can't be used to tell which
 * accounts exist.
 */
export function authFailure(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong. Try again.";
  const { status, code, reasons } = err as { status?: number; code?: string; reasons?: unknown };
  if (unreachable(err)) return "Couldn't reach PDF Wizard. Check your connection and try again.";
  if (typeof status === "number" && status >= 500) return "Sign-in isn't working right now. Try again in a few minutes.";
  if (status === 429 && RATE_LIMIT_SITE.test(err.message)) {
    return "Too many emails were sent just now. Wait a few minutes, then try again.";
  }
  if (status === 429) return "Too many tries. Wait a few minutes, then try again.";
  if (code === "invalid_credentials" || code === "email_not_confirmed" || /^(Invalid login credentials|Email not confirmed)$/i.test(err.message)) {
    return "Wrong email or password. Just signed up? Open the link in your email first.";
  }
  if (code === "weak_password") {
    const why = Array.isArray(reasons) ? reasons : [];
    return why.includes("pwned") ? "That password has appeared in a data leak, so it's easy to guess. Choose another one." : PASSWORD_RULE;
  }
  if (code === "same_password") return "That's your current password. Choose a new one.";
  // The Turnstile token ran out or was used: a new one comes by itself.
  if (code === "captcha_failed") return "The security check ran out. Wait for it to finish again, then try again.";
  if (code === "email_address_invalid" || (code === "validation_failed" && /email/i.test(err.message))) return "Enter a valid email address.";
  if (code === "signup_disabled" || code === "email_provider_disabled") return "New accounts can't be made right now. Try again later.";
  // The new password page after the session ended (signed out elsewhere, or it ran out).
  if (err.name === "AuthSessionMissingError" || code === "session_not_found" || code === "session_expired") {
    return "You've been signed out. Log in again, or ask for a new link under Forgot password.";
  }
  return "Something went wrong. Try again.";
}

/**
 * The new password page's answer to a refused change, and the field it is
 * about: a weak or unchanged password marks the new password field.
 */
export function newPasswordFailure(err: unknown): { message: string; field: "new" | null } {
  const code = err instanceof Error ? (err as { code?: string }).code : undefined;
  // With Supabase's "Secure password change" on, an older session must log in again first.
  if (err instanceof Error && (code === "reauthentication_needed" || /reauthenticat/i.test(err.message))) {
    return { message: "To change your password, log out and log in again first (or use Forgot password).", field: null };
  }
  return { message: authFailure(err), field: code === "weak_password" || code === "same_password" ? "new" : null };
}

const EMAIL_LINKS: string[] = ["recovery", "signup", "invite", "magiclink", "email_change", "email"] satisfies EmailOtpType[];

/**
 * How a link to /auth/callback signs in. One with a token hash (the reset
 * email, see the README) works in any browser, a phone's mail app too; a
 * code (OAuth, or an email link without the hash) only in the browser that
 * asked for it.
 */
export function linkSignIn(params: URLSearchParams): { type: EmailOtpType; token_hash: string } | { code: string } | null {
  const tokenHash = params.get("token_hash");
  const type = params.get("type") ?? "";
  if (tokenHash && EMAIL_LINKS.includes(type)) return { type: type as EmailOtpType, token_hash: tokenHash };
  const code = params.get("code");
  return code ? { code } : null;
}

/** The login page, coming back to `path` (with its query) afterwards. */
export function loginHref(path: string): string {
  return `/login?redirect=${encodeURIComponent(path)}`;
}

/** Pages that "Log in" in the header and footer comes back to: someone logging in there was about to pay or use a tool. */
const RETURN_AFTER_LOGIN = /^\/(pricing|tools)(\/|$)/;

/**
 * Where "Log in" in the header and footer goes from `pathname` (and its
 * query, say ?currency=EUR): back to Pricing or the tool, else on to the
 * dashboard.
 */
export function returnLoginHref(pathname: string | null | undefined, search = ""): string {
  if (!pathname || !RETURN_AFTER_LOGIN.test(pathname)) return "/login";
  return loginHref(pathname + (search && search !== "?" ? search : ""));
}

/** The sign-up page, coming back to `path` afterwards when there is one. */
export function signupHref(path?: string): string {
  return path ? `/signup?redirect=${encodeURIComponent(path)}` : "/signup";
}
