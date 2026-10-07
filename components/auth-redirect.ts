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
