import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import secretScan from "./lib/secret-scan.cjs";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // A first, safe CSP: no plugins, no <base> hijacking, forms only post here,
  // framing only by this site. It does not yet restrict script sources (that
  // needs per-request nonces for Next's inline scripts).
  {
    key: "Content-Security-Policy",
    value: "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Lets lib/server-secrets.ts tell React never to send a server secret to
  // the browser (a page that tries fails instead of leaking it).
  experimental: { taint: true },
  // Browsers and crawlers still ask for /favicon.ico; answer with the SVG icon.
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/icon.svg" }];
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // Version-stamped by scripts/copy-vendor.mjs, so safe to cache forever.
        source: "/vendor/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ];
  },
};

/**
 * The same check as `npm run build`'s prebuild (scripts/check-env.mjs), for a
 * plain `next build`: no server secret may sit in a NEXT_PUBLIC_ variable,
 * because those are copied into the browser bundle.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const problems = secretScan.envProblems(process.env);
    if (problems.length) {
      throw new Error(`Build stopped: a secret would reach the browser.\n  - ${problems.join("\n  - ")}`);
    }
  }
  return nextConfig;
}
