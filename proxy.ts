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
  // scripts; app/layout.tsx reads x-nonce for the one it adds.
  request.headers.set("x-nonce", nonce);
  request.headers.set("content-security-policy", csp);
  const response = await updateSession(request);
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets and image optimization.
     */
    "/((?!_next/static|_next/image|vendor/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
