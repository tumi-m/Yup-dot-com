import { createBrowserClient } from "@supabase/ssr";
import {
  NOT_CONFIGURED_MESSAGE,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "./config";

/**
 * Browser-side Supabase client. Throws when Supabase is not configured, so
 * call it from event handlers (where the error can be surfaced) rather than
 * during render. Use `tryCreateClient()` on pages that must render regardless.
 */
export function createClient() {
  if (!isSupabaseConfigured()) throw new Error(NOT_CONFIGURED_MESSAGE);
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/** Returns null instead of throwing when Supabase is not configured. */
export function tryCreateClient() {
  return isSupabaseConfigured()
    ? createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;
}

export { isSupabaseConfigured, NOT_CONFIGURED_MESSAGE };
