import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  BILLING_COLUMNS,
  ownPlan,
  resolveAccess,
  summarize,
  type BillingRow,
} from "@/lib/billing";
import { isAdminConfigured, teamOwnersFor } from "@/lib/billing-store";
import type { Profile } from "@/lib/types";

const COLUMNS = ["full_name", "created_at", ...BILLING_COLUMNS].join(",");

type Row = BillingRow & { full_name: string | null; created_at: string };

export interface Account {
  user: User;
  profile: Profile;
  /** Raw billing columns of the user's own row. */
  row: BillingRow;
}

/**
 * The signed-in user with their profile, creating the profile on first
 * access. `profile.plan` is the plan in force right now: it is resolved from
 * the subscription and prepaid dates and Team membership on every read, so
 * expiry needs no scheduled job. Null when signed out or when Supabase is
 * not configured.
 */
export const getAccount = cache(async (): Promise<Account | null> => {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  let { data } = await supabase.from("profiles").select(COLUMNS).eq("id", user.id).maybeSingle();
  if (!data) {
    // Normally created by a trigger on sign-up; this covers older accounts.
    // The browser role may only set these two columns: plan, email and
    // billing columns are filled in by the database. The row is read back
    // from the insert itself: repeating the GET above in the same render
    // would return Next's memoized (empty) response.
    ({ data } = await supabase
      .from("profiles")
      .insert({ id: user.id, full_name: (user.user_metadata?.full_name as string) ?? null })
      .select(COLUMNS)
      .maybeSingle());
    if (!data) {
      // Lost a race with a concurrent first request: read it, by a different URL.
      ({ data } = await supabase.from("profiles").select(COLUMNS).eq("id", user.id).limit(1).maybeSingle());
    }
  }
  if (!data) return null;
  const row = data as unknown as Row;

  const now = new Date();
  const emailVerified = !!user.email_confirmed_at && !!user.email;
  let teamOwners: BillingRow[] = [];
  if (emailVerified && ownPlan(row, now) !== "team" && isAdminConfigured()) {
    teamOwners = await teamOwnersFor(user.email!).catch(() => []);
  }
  const access = resolveAccess({ own: row, emailVerified, teamOwners }, now);
  const teamOwnerEmail = access.teamOwnerId
    ? (teamOwners.find((o) => o.id === access.teamOwnerId)?.email ?? null)
    : null;

  const profile: Profile = {
    id: row.id,
    email: row.email ?? user.email ?? "",
    full_name: row.full_name,
    plan: access.plan,
    created_at: row.created_at,
    billing: summarize(row, access, now, teamOwnerEmail),
  };
  return { user, profile, row };
});

/** See getAccount(). */
export async function getProfile(): Promise<Profile | null> {
  return (await getAccount())?.profile ?? null;
}
