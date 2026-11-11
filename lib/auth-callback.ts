import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { linkSignIn, safeRedirect } from "@/components/auth-redirect";
import { refuseCrossSite } from "@/lib/cross-site";

/**
 * /auth/callback, the address in sign-up, reset and OAuth emails.
 *
 * A code (OAuth, or an email link without the hash) only works in the
 * browser that asked for it, so it signs in straight from the link. A token
 * hash works in any browser, so someone could send theirs to you, or have
 * another site open it in your browser, and you would be using their account
 * without noticing (saving files and payment details into it). That link
 * only waits on CONFIRM_PATH, in a cookie, and signs in when Continue there
 * posts back from this site. Scanners that open links in emails don't use it
 * up either.
 */

/** The Continue page for an email link. */
export const CONFIRM_PATH = "/auth/confirm";
/** The email link waiting there. */
export const PENDING_LINK_COOKIE = "pw-email-link";

const PENDING_COOKIE = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/auth",
  // As long as Supabase's email links last by default.
  maxAge: 60 * 60,
} as const;

export interface PendingLink {
  type: EmailOtpType;
  token_hash: string;
  /** Same-site path to go on to, or "". */
  next: string;
}

export function encodePendingLink(link: PendingLink): string {
  return Buffer.from(JSON.stringify(link)).toString("base64url");
}

/** The waiting link, or null when there is none or it isn't one we wrote. */
export function readPendingLink(value: string | null | undefined): PendingLink | null {
  if (!value || value.length > 2048) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const link = linkSignIn(new URLSearchParams({ token_hash: str(v.token_hash), type: str(v.type) }));
  if (!link || !("token_hash" in link)) return null;
  return { ...link, next: safeRedirect(str(v.next), "") };
}

/** A cookie from a Cookie header. */
export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

type LinkAuth = {
  exchangeCodeForSession(code: string): Promise<{ error: unknown }>;
  verifyOtp(link: { type: EmailOtpType; token_hash: string }): Promise<{ error: unknown }>;
};

export interface CallbackDeps {
  configured: boolean;
  /** Supabase Auth, writing the session cookies on this response. */
  auth: () => Promise<LinkAuth>;
}

// An expired link, or one opened in another browser: the login page
// explains, then carries on to the same place.
function toLoginError(origin: string, back: string, status?: number) {
  const redirect = back ? `&redirect=${encodeURIComponent(back)}` : "";
  return NextResponse.redirect(`${origin}/login?error=auth${redirect}`, status);
}

export async function handleCallbackGet(request: Request, deps: CallbackDeps): Promise<Response> {
  const { searchParams, origin } = new URL(request.url);
  // Back to where sign-up started (say, pricing), same-site paths only.
  const back = safeRedirect(searchParams.get("next"), "");

  if (!deps.configured) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const link = linkSignIn(searchParams);
  if (link && "token_hash" in link) {
    const res = NextResponse.redirect(`${origin}${CONFIRM_PATH}`, 303);
    res.cookies.set(PENDING_LINK_COOKIE, encodePendingLink({ ...link, next: back }), PENDING_COOKIE);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  if (link) {
    const { error } = await (await deps.auth()).exchangeCodeForSession(link.code);
    if (!error) {
      return NextResponse.redirect(`${origin}${back || "/dashboard"}`);
    }
  }
  return toLoginError(origin, back);
}

/** Continue on CONFIRM_PATH: signs in with the waiting email link. */
export async function handleCallbackPost(request: Request, deps: CallbackDeps): Promise<Response> {
  // Only this site's page may use the link (a plain form post).
  const refused = refuseCrossSite(request, { json: false });
  if (refused) return refused;
  const { origin } = new URL(request.url);
  const pending = readPendingLink(cookieValue(request.headers.get("cookie"), PENDING_LINK_COOKIE));

  let res = toLoginError(origin, pending?.next ?? "", 303);
  if (pending && deps.configured) {
    const { error } = await (await deps.auth()).verifyOtp({ type: pending.type, token_hash: pending.token_hash });
    if (!error) res = NextResponse.redirect(`${origin}${pending.next || "/dashboard"}`, 303);
  }
  // A link works once, whatever happened.
  res.cookies.set(PENDING_LINK_COOKIE, "", { ...PENDING_COOKIE, maxAge: 0 });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
