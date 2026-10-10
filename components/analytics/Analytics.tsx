"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { Cookie } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  OPEN_CONSENT_EVENT,
  applyConsent,
  clearGaCookies,
  readConsent,
  saveConsent,
  type ConsentChoice,
} from "@/lib/analytics";

/**
 * Google Analytics behind a consent banner (Consent Mode v2, basic mode).
 * The denied defaults are already set by the inline script in <head>; this
 * loads gtag.js only once the visitor accepts, and shows the banner until
 * they choose. Rendered by the root layout only when a measurement ID is set.
 */
export function Analytics({ gaId }: { gaId: string }) {
  const [load, setLoad] = useState(false);
  const [open, setOpen] = useState(false);
  /** The control that reopened the banner, to return focus to. */
  const opener = useRef<HTMLElement | null>(null);
  const firstButton = useRef<HTMLButtonElement>(null);
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    const saved = readConsent();
    if (saved) {
      if (applyConsent(saved, gaId)) setLoad(true);
    } else {
      setOpen(true);
    }
    const reopen = (e: Event) => {
      opener.current = (e as CustomEvent<HTMLElement | undefined>).detail ?? null;
      setReopened(true);
      setOpen(true);
    };
    window.addEventListener(OPEN_CONSENT_EVENT, reopen);
    return () => window.removeEventListener(OPEN_CONSENT_EVENT, reopen);
  }, [gaId]);

  // Reopened from "Cookie settings": move focus into the banner.
  useEffect(() => {
    if (open && reopened) firstButton.current?.focus();
  }, [open, reopened]);

  function close() {
    setOpen(false);
    setReopened(false);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
  }

  function choose(choice: ConsentChoice) {
    saveConsent(choice);
    if (applyConsent(choice, gaId)) setLoad(true);
    else clearGaCookies();
    close();
  }

  return (
    <>
      {load && <Script id="gtag-js" src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`} strategy="afterInteractive" />}
      {open && (
        <section
          aria-label="Cookie consent"
          onKeyDown={(e) => {
            // Escape keeps the earlier choice; a first visit has none to keep.
            if (e.key === "Escape" && reopened) close();
          }}
          className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-3xl rounded-2xl border border-border bg-card/95 p-4 shadow-2xl shadow-primary/15 backdrop-blur-md motion-safe:animate-rise sm:inset-x-6 sm:bottom-6 sm:flex sm:items-center sm:gap-4 sm:p-5"
        >
          <p className="text-sm leading-6 sm:flex-1">
            <Cookie aria-hidden className="mr-1.5 inline h-4 w-4 -translate-y-px text-primary" />
            Analytics cookies help us see which tools get used. No ads.{" "}
            <Link href="/privacy#cookies" className="tap font-medium text-accent-foreground underline underline-offset-2 hover:text-primary">
              Privacy
            </Link>
          </p>
          <div className="mt-3 grid shrink-0 grid-cols-2 gap-2 sm:mt-0 sm:flex">
            <Button ref={firstButton} variant="outline" className="h-11 sm:px-5" onClick={() => choose("denied")}>
              Decline
            </Button>
            <Button className="h-11 sm:px-5" onClick={() => choose("granted")}>
              Accept
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
