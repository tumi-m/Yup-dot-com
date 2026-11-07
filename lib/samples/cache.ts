/**
 * Cache for the Sample Finder: video titles from YouTube, MusicBrainz
 * searches and lookups, and the pause after MusicBrainz refuses. Keys name
 * only the video or song (yt:<id>, mbq:<hash of the query>, mbrec:<id>) or
 * the pause (mb:pause); nothing about who asked is ever stored.
 *
 * Production: a small in-memory LRU per server instance in front of the
 * sample_cache table in Supabase (service role only, RLS on with no
 * policies), so every instance shares what one looked up. Without a
 * service-role key, or while the database fails, only memory is used.
 */
import "server-only";

export interface SampleCache {
  /** `fresh`: skip this instance's memory and read the shared copy (one another instance may have just changed). */
  get<T = unknown>(key: string, opts?: { fresh?: boolean }): Promise<T | null>;
  /** `ttl` in seconds. */
  set(key: string, value: unknown, ttl: number): Promise<void>;
}

export const DAY = 24 * 60 * 60;
export const TTL = {
  video: 7 * DAY,
  search: 30 * DAY,
  recording: 30 * DAY,
  /** Not found, private, nothing matched. */
  negative: DAY,
} as const;

/* ------------------------------------------------------------------ */
/* Memory                                                              */
/* ------------------------------------------------------------------ */

export function memoryCache(max = 500, now: () => number = Date.now): SampleCache {
  const map = new Map<string, { value: unknown; expires: number }>();
  return {
    async get<T>(key: string) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expires <= now()) {
        map.delete(key);
        return null;
      }
      // Most recently used last.
      map.delete(key);
      map.set(key, hit);
      return hit.value as T;
    },
    async set(key, value, ttl) {
      map.delete(key);
      map.set(key, { value, expires: now() + ttl * 1000 });
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */

/** The part of a supabase-js client this module uses. */
export interface TableClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }> };
    };
    upsert(row: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }>;
    delete(): {
      eq(column: string, value: string): PromiseLike<{ error: { message?: string } | null }>;
      lt(column: string, value: string): PromiseLike<{ error: { message?: string } | null }>;
    };
  };
}

/** Rows past their time are deleted when read, and about one write in 100 clears all expired rows. */
export function supabaseCache(client: TableClient, opts: { now?: () => number; random?: () => number } = {}): SampleCache {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const table = () => client.from("sample_cache");
  return {
    async get<T>(key: string) {
      const { data, error } = await table().select("value, expires_at").eq("key", key).maybeSingle();
      if (error) throw new Error(`sample_cache: ${error.message ?? "read failed"}`);
      const row = data as { value: unknown; expires_at: string } | null;
      if (!row) return null;
      if (Date.parse(row.expires_at) <= now()) {
        void Promise.resolve(table().delete().eq("key", key)).catch(() => {});
        return null;
      }
      return row.value as T;
    },
    async set(key, value, ttl) {
      const { error } = await table().upsert({ key, value, expires_at: new Date(now() + ttl * 1000).toISOString() });
      if (error) throw new Error(`sample_cache: ${error.message ?? "write failed"}`);
      if (random() < 0.01) {
        void Promise.resolve(table().delete().lt("expires_at", new Date(now()).toISOString())).catch(() => {});
      }
    },
  };
}

/**
 * Memory first, then the shared store. A store that fails is skipped (with
 * one warning), so a missing table never breaks a lookup.
 */
export function layeredCache(front: SampleCache, back: SampleCache | null): SampleCache {
  let warned = false;
  const warn = (err: unknown) => {
    if (warned) return;
    warned = true;
    console.error(
      "Sample cache: Supabase unavailable, caching in memory. Run supabase/migrations/20261107000000_sample_cache.sql.",
      err instanceof Error ? err.message : err
    );
  };
  return {
    async get<T>(key: string, opts?: { fresh?: boolean }) {
      if (opts?.fresh && back) {
        try {
          const shared = await back.get<T>(key);
          if (shared !== null) return shared;
        } catch (err) {
          warn(err);
        }
        return front.get<T>(key);
      }
      const hit = await front.get<T>(key);
      if (hit !== null || !back) return hit;
      try {
        const shared = await back.get<T>(key);
        // Kept in memory for an hour at most; the shared row stays the source.
        if (shared !== null) await front.set(key, shared, 60 * 60);
        return shared;
      } catch (err) {
        warn(err);
        return null;
      }
    },
    async set(key, value, ttl) {
      await front.set(key, value, Math.min(ttl, 60 * 60));
      if (!back) return;
      try {
        await back.set(key, value, ttl);
      } catch (err) {
        warn(err);
        // Without the shared store, memory keeps it for its full time.
        await front.set(key, value, ttl);
      }
    },
  };
}

let cache: SampleCache | null = null;

function createDefaultCache(): SampleCache {
  const memory = memoryCache();
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return memory;
  try {
    // Lazily, so the service key never reaches a client bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require("@supabase/supabase-js");
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    return layeredCache(memory, supabaseCache(admin));
  } catch (err) {
    console.error("Sample cache: Supabase client unavailable.", err instanceof Error ? err.message : err);
    return memory;
  }
}

export function sampleCache(): SampleCache {
  return (cache ??= createDefaultCache());
}
