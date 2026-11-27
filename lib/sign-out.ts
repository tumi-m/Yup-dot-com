import { NextResponse } from "next/server";
import { refuseCrossSite } from "@/lib/cross-site";

/**
 * POST /auth/signout. Supabase clears the session cookies only after its
 * server agrees: when it can't be reached, answers 500 or doesn't answer,
 * the cookies stayed and the browser was still signed in once it came back
 * (on a shared computer, for the next person). The cookies go whatever
 * Supabase says.
 */

/** Supabase's session cookies: sb-<project>-auth-token, in .0, .1… parts when long, and the PKCE verifier. */
const SESSION_COOKIE = /^sb-[^=;\s]+-auth-token(-code-verifier)?(\.\d+)?$/;

/** How long sign-out waits for Supabase to end the session everywhere. */
export const SIGN_OUT_WAIT_MS = 5000;

export interface SignOutDeps {
  configured: boolean;
  /** Supabase Auth's signOut, writing its cookies on this response. */
  signOut: () => Promise<{ error: unknown }>;
  waitMs?: number;
}

/** The session cookie names a Cookie header holds. */
export function sessionCookieNames(header: string | null): string[] {
  return (header ?? "")
    .split(/;\s*/)
    .map((part) => part.slice(0, Math.max(0, part.indexOf("="))))
    .filter((name) => SESSION_COOKIE.test(name));
}

export async function handleSignOut(request: Request, deps: SignOutDeps): Promise<Response> {
  // Another site's form could otherwise sign people out (the site's own
  // sign-out button posts a form, so any body type is fine).
  const refused = refuseCrossSite(request, { json: false });
  if (refused) return refused;
  if (deps.configured) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<{ error: unknown }>((resolve) => {
      timer = setTimeout(() => resolve({ error: "timeout" }), deps.waitMs ?? SIGN_OUT_WAIT_MS);
    });
    const { error } = await Promise.race([deps.signOut().catch((err: unknown) => ({ error: err })), gaveUp]);
    clearTimeout(timer);
    if (error) console.error("sign-out: Supabase didn't end the session; clearing it here", error instanceof Error ? error.message : error);
  }
  const res = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  // delete() (an Expires in 1970), not Max-Age=0: Next drops a Max-Age of 0
  // when it merges the cookies Supabase wrote, leaving an empty cookie behind.
  for (const name of sessionCookieNames(request.headers.get("cookie"))) res.cookies.delete({ name, path: "/" });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
