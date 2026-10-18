import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { loginHref } from "@/components/auth-redirect";
import { AUTH_COOKIE_OPTIONS, SUPABASE_ANON_KEY, SUPABASE_URL, authCookie, isSupabaseConfigured } from "./config";

type CookieToSet = { name: string; value: string; options: CookieOptions };

const PROTECTED_PREFIXES = ["/dashboard", "/editor", "/settings"];

function isProtected(path: string) {
  return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * To the login page, then back to this exact URL. The query goes inside
 * ?redirect, so a payment reference on return from Paystack survives the
 * login.
 */
function toLogin(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(loginHref(pathname + search), request.url));
}

/** Refreshes the Supabase session and guards protected routes. */
export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // Without credentials there is no session to refresh. Let public pages and
  // the browser-only tools through rather than failing every request.
  if (!isSupabaseConfigured()) {
    if (isProtected(path)) return toLogin(request);
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, authCookie(options))
        );
      },
    },
  });

  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    // A transient auth outage should not take down public pages.
    if (!isProtected(path)) return response;
  }

  if (isProtected(path) && !user) return toLogin(request);

  return response;
}
