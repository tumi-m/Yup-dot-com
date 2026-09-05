import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import type { Profile } from "@/lib/types";

/**
 * Returns the current user's profile row, creating one on first access.
 * Returns null when there is no authenticated user, or when Supabase has not
 * been configured for this deployment.
 */
export async function getProfile(): Promise<Profile | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: existing } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (existing) return existing as Profile;

  const { data: created } = await supabase
    .from("profiles")
    .insert({
      id: user.id,
      email: user.email,
      full_name: (user.user_metadata?.full_name as string) ?? null,
      plan: "free",
    })
    .select("*")
    .single();

  return (created as Profile) ?? null;
}
