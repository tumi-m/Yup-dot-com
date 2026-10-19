import { createBrowserClient, type CookieOptions } from "@supabase/ssr";
import {
  AUTH_COOKIE_OPTIONS,
  NOT_CONFIGURED_MESSAGE,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  authCookie,
  isSupabaseConfigured,
} from "./config";

/** document.cookie, as @supabase/ssr's default reads it. */
function readCookies(): { name: string; value: string }[] {
  if (typeof document === "undefined" || !document.cookie) return [];
  return document.cookie.split(/;\s*/).flatMap((pair) => {
    const i = pair.indexOf("=");
    if (i < 1) return [];
    try {
      return [{ name: pair.slice(0, i), value: decodeURIComponent(pair.slice(i + 1)) }];
    } catch {
      return [];
    }
  });
}

/** Writes a session cookie with the lifetime capped (see AUTH_COOKIE_OPTIONS). */
function writeCookie(name: string, value: string, options: CookieOptions) {
  const o = authCookie(options);
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${o.path}; Max-Age=${Math.floor(o.maxAge ?? AUTH_COOKIE_OPTIONS.maxAge)}; SameSite=Lax`;
  if (o.domain) cookie += `; Domain=${o.domain}`;
  if (o.secure) cookie += "; Secure";
  document.cookie = cookie;
}

const browserOptions = {
  cookieOptions: AUTH_COOKIE_OPTIONS,
  cookies: {
    getAll: readCookies,
    setAll: (cookies: { name: string; value: string; options: CookieOptions }[]) =>
      cookies.forEach(({ name, value, options }) => writeCookie(name, value, options)),
  },
};

/**
 * Browser-side Supabase client. Throws when Supabase is not configured, so
 * call it from event handlers (where the error can be surfaced) rather than
 * during render. Use `tryCreateClient()` on pages that must render regardless.
 */
export function createClient() {
  if (!isSupabaseConfigured()) throw new Error(NOT_CONFIGURED_MESSAGE);
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, browserOptions);
}

/** Returns null instead of throwing when Supabase is not configured. */
export function tryCreateClient() {
  return isSupabaseConfigured() ? createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, browserOptions) : null;
}

export { isSupabaseConfigured, NOT_CONFIGURED_MESSAGE };
