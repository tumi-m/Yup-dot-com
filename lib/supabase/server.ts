import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { User } from "@supabase/supabase-js";
import {
  NOT_CONFIGURED_MESSAGE,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "./config";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Server-side Supabase client bound to the request cookies. Use inside Server
 * Components, Route Handlers, and Server Actions.
 *
 * Throws when Supabase is not configured — call `getCurrentUser()` instead on
 * pages that must render for signed-out visitors.
 */
export async function createClient() {
  if (!isSupabaseConfigured()) throw new Error(NOT_CONFIGURED_MESSAGE);

  const cookieStore = await cookies();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component — middleware refreshes the session.
        }
      },
    },
  });
}

/**
 * The signed-in user, or null when nobody is signed in *or* when Supabase is
 * not configured. Safe to call from any public page.
 */
export async function getCurrentUser(): Promise<User | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return user;
  } catch {
    return null;
  }
}

/**
 * Privileged client using the service-role key. Server-only — never expose the
 * service key to the browser. Used by webhooks and admin operations.
 */
export function createAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_URL are required for admin operations."
    );
  }
  // Imported lazily so the service key never reaches a client bundle.
  const { createClient: createSupabaseClient } = require("@supabase/supabase-js");
  return createSupabaseClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false },
  });
}
