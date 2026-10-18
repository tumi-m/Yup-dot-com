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

/** The link to the other auth page ("/login" ↔ "/signup"), keeping ?redirect. */
export function authSwitchHref(target: "/login" | "/signup", search: string): string {
  const redirect = safeRedirect(new URLSearchParams(search).get("redirect"), "");
  return redirect ? `${target}?redirect=${encodeURIComponent(redirect)}` : target;
}

/** Where a password reset link signs people in, to choose a new password. */
export const NEW_PASSWORD_PATH = "/settings/password";

/** The address in the reset email: /auth/callback signs in, then on to NEW_PASSWORD_PATH. */
export function resetLinkTarget(origin: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(NEW_PASSWORD_PATH)}`;
}

/** What to say on /login?error=auth, after a confirmation or reset link fails. */
export function authErrorMessage(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("error") !== "auth") return null;
  return params.get("redirect") === NEW_PASSWORD_PATH
    ? "That reset link has expired or was opened in another browser. Ask for a new one under Forgot password."
    : "That link has expired or was opened in another browser. Log in, or sign up again to get a new link.";
}

/** The login page, coming back to `path` (with its query) afterwards. */
export function loginHref(path: string): string {
  return `/login?redirect=${encodeURIComponent(path)}`;
}
