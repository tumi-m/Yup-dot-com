import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { contentSecurityPolicy, newNonce } from "@/lib/csp";

/**
 * Next 16 "proxy" (formerly middleware): refreshes the session, guards
 * routes, and sets the Content-Security-Policy with a fresh nonce.
 */
export async function proxy(request: NextRequest) {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce);
  // Next.js reads the nonce from the request's policy and puts it on its own
  // scripts; app/layout.tsx reads x-nonce for the ones it adds.
  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy", csp);
  const response = await updateSession(request);
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Every path except Next.js's own static files, the copied vendor files
     * and the site icon. Not "anything ending in .png": /editor/x.png is a
     * page too, and needs the login check and the script CSP.
     */
    "/((?!_next/static/|_next/image|vendor/|favicon\\.ico$|icon\\.svg$).*)",
  ],
};
