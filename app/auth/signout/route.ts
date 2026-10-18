import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { refuseCrossSite } from "@/lib/cross-site";

export async function POST(request: Request) {
  // Another site's form could otherwise sign people out (the site's own
  // sign-out button posts a form, so any body type is fine).
  const refused = refuseCrossSite(request, { json: false });
  if (refused) return refused;
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
