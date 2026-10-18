import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { linkSignIn, safeRedirect } from "@/components/auth-redirect";

/** Signs in from an email confirmation, password reset or OAuth link. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  // Back to where sign-up started (say, pricing), same-site paths only.
  const back = safeRedirect(searchParams.get("next"), "");
  const next = back || "/dashboard";

  if (!isSupabaseConfigured()) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const link = linkSignIn(searchParams);
  if (link) {
    const { auth } = await createClient();
    const { error } = "code" in link ? await auth.exchangeCodeForSession(link.code) : await auth.verifyOtp(link);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // An expired link, or one opened in another browser: the login page
  // explains, then carries on to the same place.
  const redirect = back ? `&redirect=${encodeURIComponent(back)}` : "";
  return NextResponse.redirect(`${origin}/login?error=auth${redirect}`);
}
