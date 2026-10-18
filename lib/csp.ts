/**
 * Content-Security-Policy for pages, made per request with a fresh nonce
 * (proxy.ts). Only scripts carrying the nonce run (Next.js puts it on its
 * own scripts, app/layout.tsx on the consent script), plus the scripts
 * those load ('strict-dynamic': gtag.js, Turnstile, the tools' workers).
 * An injected <script>, an onerror="" handler or a javascript: link does not
 * run, and fetch() can reach only this site and the services listed here,
 * so a script that did get in couldn't send a session elsewhere that way.
 *
 * 'wasm-unsafe-eval' lets the PDF, OCR, image and video tools compile their
 * WebAssembly; it doesn't allow eval(). 'self' and https: only matter to
 * browsers too old for 'strict-dynamic', which ignore it.
 *
 * Responses the proxy doesn't see (files under /_next/static, /vendor and
 * images) keep the plainer policy in next.config.ts.
 */
const GOOGLE_ANALYTICS = [
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://*.googletagmanager.com",
  "https://*.g.doubleclick.net",
  "https://www.google.com",
];

function origin(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

export interface CspSettings {
  dev: boolean;
  supabaseUrl?: string;
  mediaWorkerUrl?: string;
  analytics: boolean;
  turnstile: boolean;
}

/** From the environment. NEXT_PUBLIC_ values are named in full so they're inlined at build time. */
export function cspSettings(): CspSettings {
  return {
    dev: process.env.NODE_ENV === "development",
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    mediaWorkerUrl: process.env.MEDIA_WORKER_URL,
    analytics: !!process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim(),
    turnstile: !!process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim(),
  };
}

export function contentSecurityPolicy(nonce: string, settings: CspSettings = cspSettings()): string {
  const { dev } = settings;
  const supabase = origin(settings.supabaseUrl);
  const connect = [
    "'self'",
    "blob:",
    "data:",
    supabase,
    supabase?.replace(/^http/, "ws"),
    // YouTube downloads poll the media worker from the browser.
    origin(settings.mediaWorkerUrl),
    ...(settings.analytics ? GOOGLE_ANALYTICS : []),
    settings.turnstile ? "https://challenges.cloudflare.com" : null,
    dev ? "ws:" : null,
  ].filter(Boolean);
  return [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' https:${dev ? " 'unsafe-eval'" : ""}`,
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

/** A random nonce, new for every response. */
export function newNonce(): string {
  return btoa(crypto.randomUUID());
}
