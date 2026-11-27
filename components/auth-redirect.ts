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

const RATE_LIMIT_SITE = /email rate limit/i;

/**
 * Supabase answers that would tell whether an email has an account. "Forgot
 * password" for an unknown email always succeeds at once; for a known one
 * Supabase waits between emails ("For security purposes, you can only
 * request this after 47 seconds."), so asking twice would tell. Sign-up says
 * "User already registered" when email confirmation is off. The form shows
 * its usual message for these instead.
 */
export function revealsAccount(err: unknown, mode: AuthMode): boolean {
  if (!(err instanceof Error)) return false;
  const { status, code } = err as { status?: number; code?: string };
  if (mode === "reset") return status === 429 && code === "over_email_send_rate_limit" && !RATE_LIMIT_SITE.test(err.message);
  if (mode === "signup") return code === "user_already_exists" || /already registered/i.test(err.message);
  return false;
}

/**
 * What to say when Supabase turns a request down, or can't be reached. Its
 * messages for too many emails or tries, a password without digits ("at
 * least one character of each: abcdefghijklmnopqrstuvwxyzABCD…", which
 * overflowed the form on a phone) and a dropped connection ("Failed to
 * fetch") are jargon. Logging in, a wrong password and an unconfirmed email
 * get the same answer, so it can't be used to tell which accounts exist.
 */
export function authFailure(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong.";
  const { status, code, reasons } = err as { status?: number; code?: string; reasons?: unknown };
  // No answer, a gateway error or a page that isn't Supabase's (supabase-js
  // names these), or the browser's own fetch failing.
  if (err.name === "AuthRetryableFetchError" || err.name === "AuthUnknownError" || /^(Failed to fetch|Load failed|NetworkError)/i.test(err.message)) {
    return "Couldn't reach PDF Wizard. Check your connection and try again.";
  }
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
    if (why.includes("pwned")) return "That password has appeared in a data leak, so it's easy to guess. Choose another one.";
    if (why.includes("characters") || /at least one character of each/i.test(err.message)) return `Use ${PASSWORD_HINT.charAt(0).toLowerCase()}${PASSWORD_HINT.slice(1)}`;
  }
  if (code === "same_password") return "That's your current password. Choose a new one.";
  return err.message;
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

/** The sign-up page, coming back to `path` afterwards when there is one. */
export function signupHref(path?: string): string {
  return path ? `/signup?redirect=${encodeURIComponent(path)}` : "/signup";
}
