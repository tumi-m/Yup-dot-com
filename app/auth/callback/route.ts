import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { handleCallbackGet, handleCallbackPost, type CallbackDeps } from "@/lib/auth-callback";

const deps = (): CallbackDeps => ({
  configured: isSupabaseConfigured(),
  auth: async () => (await createClient()).auth,
});

/** Signs in from an OAuth link; an email link with a token hash goes to Continue first (lib/auth-callback.ts). */
export async function GET(request: Request) {
  return handleCallbackGet(request, deps());
}

/** Continue on /auth/confirm, from this site only. */
export async function POST(request: Request) {
  return handleCallbackPost(request, deps());
}
