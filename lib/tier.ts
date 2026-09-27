import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import type { Tier } from "@/lib/limits";

/** The caller's usage tier: "guest" without an account, else their plan. */
export async function resolveTier() {
  const user = await getCurrentUser();
  const profile = user ? await getProfile().catch(() => null) : null;
  const tier: Tier = user ? (profile?.plan ?? "free") : "guest";
  return { user, tier };
}
