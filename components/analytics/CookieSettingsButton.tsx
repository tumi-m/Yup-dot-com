"use client";

import { GA_ID, OPEN_CONSENT_EVENT } from "@/lib/analytics";

/** Reopens the cookie banner. Renders nothing when analytics isn't configured. */
export function CookieSettingsButton({ className }: { className?: string }) {
  if (!GA_ID) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => window.dispatchEvent(new CustomEvent(OPEN_CONSENT_EVENT, { detail: e.currentTarget }))}
    >
      Cookie settings
    </button>
  );
}
