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

/**
 * What to say when Supabase turns a request down. Its message for too many
 * emails is jargon; the wait before asking again for one address
 * ("For security purposes, you can only request this after 47 seconds.") is
 * clear as it is.
 */
export function authFailure(err: unknown): string {
  if (!(err instanceof Error)) return "Something went wrong.";
  if ((err as { status?: number }).status === 429 && /email rate limit/i.test(err.message)) {
    return "Too many emails were sent just now. Wait a few minutes, then try again.";
  }
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
