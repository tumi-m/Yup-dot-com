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

/** What to say on /login?error=auth, after a confirmation link fails. */
export function authErrorMessage(search: string): string | null {
  return new URLSearchParams(search).get("error") === "auth"
    ? "That link has expired or was opened in another browser. Log in, or sign up again to get a new link."
    : null;
}
