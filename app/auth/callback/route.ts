import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { safeRedirect } from "@/components/auth-redirect";

/** Exchanges the email-confirmation / OAuth code for a session. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Back to where sign-up started (say, pricing), same-site paths only.
  const back = safeRedirect(searchParams.get("next"), "");
  const next = back || "/dashboard";

  if (!isSupabaseConfigured()) {
    return NextResponse.redirect(`${origin}/login`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // An expired link, or one opened in another browser: the login page
  // explains, then carries on to the same place.
  const redirect = back ? `&redirect=${encodeURIComponent(back)}` : "";
  return NextResponse.redirect(`${origin}/login?error=auth${redirect}`);
}
