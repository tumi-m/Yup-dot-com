"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Cloudflare Turnstile site key, for Supabase Auth's bot protection
 * (Authentication → Attack Protection). Unset: no check is shown, and
 * Supabase's CAPTCHA setting must stay off or nobody can log in.
 */
export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || "";

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")));
    script.onerror = () => {
      loading = null;
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * The Turnstile check on the log-in, sign-up and reset forms. Calls onToken
 * with a token once it passes, and with null when the token expires. A token
 * works once: change `resetKey` after each request for a new one.
 */
export function Captcha({ onToken, resetKey }: { onToken: (token: string | null) => void; resetKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const tokenTo = useRef(onToken);
  tokenTo.current = onToken;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let alive = true;
    loadTurnstile()
      .then((turnstile) => {
        if (!alive || !box.current) return;
        widget.current = turnstile.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token: string) => tokenTo.current(token),
          "expired-callback": () => tokenTo.current(null),
          "error-callback": () => tokenTo.current(null),
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, []);

  useEffect(() => {
    if (!resetKey || !widget.current) return;
    tokenTo.current(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey]);

  if (!TURNSTILE_SITE_KEY) return null;
  return (
    <div>
      <div ref={box} className="flex min-h-[65px] justify-center" />
      {failed && (
        <p role="alert" className="mt-2 text-center text-sm text-destructive">
          The security check didn&apos;t load. Reload the page, or allow challenges.cloudflare.com if you block it.
        </p>
      )}
    </div>
  );
}
