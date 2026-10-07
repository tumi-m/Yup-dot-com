"use client";

import { useEffect, useState } from "react";
import type { PriceDisplay } from "@/lib/currency";

let pending: Promise<PriceDisplay | null> | null = null;

/**
 * Local-currency price strings for client-only UI, fetched once per page
 * load (when `enabled`). Pages rendered on the server pass a PriceDisplay
 * down instead. Null until loaded or on failure: callers then show rand.
 */
export function useLocalPrices(enabled = true): PriceDisplay | null {
  const [display, setDisplay] = useState<PriceDisplay | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (!pending) {
      const override = new URLSearchParams(window.location.search).get("currency");
      pending = fetch(`/api/prices${override ? `?currency=${encodeURIComponent(override)}` : ""}`)
        .then((r) => (r.ok ? (r.json() as Promise<PriceDisplay>) : null))
        .catch(() => null);
    }
    let live = true;
    pending.then((d) => live && setDisplay(d));
    return () => {
      live = false;
    };
  }, [enabled]);
  return display;
}
