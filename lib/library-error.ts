/**
 * What the cloud library (the dashboard) says when Supabase fails it.
 * Supabase's words reached people as they came: "TypeError: Failed to
 * fetch" for a dropped connection, and "Not authenticated." when the
 * session check couldn't reach Supabase at all. The database's own
 * refusals (P0001: the Free plan's 5 documents, its 50 MB files) are written
 * for people and are shown as they are.
 */

export const LIBRARY_OFFLINE = "Couldn't reach your library. Check your connection and try again.";
export const LIBRARY_SIGNED_OUT = "You've been signed out. Log in again to upload.";

const OFFLINE = /Failed to fetch|Load failed|NetworkError|fetch failed/i;

type SupabaseError = { name?: string; message?: string; code?: string; status?: number; statusCode?: string | number };

/**
 * `err` is a supabase-js error (auth, database or storage), or null when the
 * session check found no one signed in.
 */
export function libraryError(err: unknown): string {
  if (!err) return LIBRARY_SIGNED_OUT;
  const e = err as SupabaseError;
  const message = typeof e.message === "string" ? e.message : "";
  if (e.name === "AuthRetryableFetchError" || OFFLINE.test(message)) return LIBRARY_OFFLINE;
  // The session check: no session, or one Supabase no longer accepts.
  if (e.name === "AuthSessionMissingError" || (e.name?.startsWith("Auth") && (e.status === 401 || e.status === 403))) return LIBRARY_SIGNED_OUT;
  if (e.code === "P0001" && message) return message;
  return "Couldn't save it to your library. Try again.";
}
