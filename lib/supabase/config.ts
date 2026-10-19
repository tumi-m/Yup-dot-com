/**
 * Supabase environment configuration.
 *
 * The tool suite runs entirely in the browser and needs no backend, so the app
 * must stay usable when Supabase has not been configured yet — a fresh deploy
 * should serve the marketing pages and every tool, and only gate the features
 * that genuinely need an account.
 *
 * NEXT_PUBLIC_* values are inlined at build time, so these read correctly on
 * both the server and the client.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

/**
 * The session cookie. @supabase/ssr's default is readable by scripts, sent
 * over plain HTTP and kept for 400 days. Here it is Secure in production
 * (HTTPS only) and lasts 30 days from the last refresh, so a signed-in
 * visitor stays signed in but a browser left alone for a month is signed
 * out. It can't be HttpOnly: the browser client reads the session itself.
 * The Content-Security-Policy (proxy.ts) keeps scripts that could read it
 * off the site.
 */
export const AUTH_COOKIE_OPTIONS = {
  path: "/",
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: 60 * 60 * 24 * 30,
} as const;

/** @supabase/ssr always writes maxAge 400 days, whatever cookieOptions says: cap it (a removal keeps 0). */
export function authCookie<T extends { maxAge?: number }>(options: T): T {
  const maxAge = options.maxAge === 0 ? 0 : Math.min(options.maxAge ?? AUTH_COOKIE_OPTIONS.maxAge, AUTH_COOKIE_OPTIONS.maxAge);
  return { ...options, ...AUTH_COOKIE_OPTIONS, maxAge };
}

export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

export const NOT_CONFIGURED_MESSAGE =
  "Accounts are not available yet — this deployment has no Supabase credentials configured. All PDF tools still work without an account.";
