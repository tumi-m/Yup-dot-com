/**
 * Supabase environment configuration.
 *
 * The tool suite runs entirely in the browser and needs no backend, so the app
 * must stay usable when Supabase has not been configured yet — a fresh deploy
 * should serve the marketing pages and every tool, and only gate the features
 * that genuinely need an account.
 *
 * NEXT_PUBLIC_* values are inlined at build time, so these read correctly on
 * both the server and the client.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
}

export const NOT_CONFIGURED_MESSAGE =
  "Accounts are not available yet — this deployment has no Supabase credentials configured. All PDF tools still work without an account.";
