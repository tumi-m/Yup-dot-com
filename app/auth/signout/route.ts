import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { handleSignOut } from "@/lib/sign-out";

/** Signs out, and clears the session cookies even when Supabase can't be reached (lib/sign-out.ts). */
export async function POST(request: Request) {
  return handleSignOut(request, {
    configured: isSupabaseConfigured(),
    signOut: async () => (await createClient()).auth.signOut(),
  });
}
