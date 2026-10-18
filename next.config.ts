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
  // For responses the proxy doesn't see (/_next/static, /vendor, the icon): no
  // plugins, no <base> hijacking, forms only post here, framing only by this
  // site. Pages get a stricter policy with a per-request nonce that also
  // limits scripts and connections (lib/csp.ts, proxy.ts).
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
 * The same checks as `npm run build`'s prebuild (scripts/check-env.mjs and
 * scripts/check-source.mjs), for a plain `next build`: no server secret may
 * sit in a NEXT_PUBLIC_ variable, because those are copied into the browser
 * bundle, and no password or key may be written into the code.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const used = new Set(secretScan.publicVarsInSource(process.cwd()).keys());
    const problems = [...secretScan.envProblems(process.env, used), ...secretScan.sourceProblems(process.cwd()).problems];
    if (problems.length) {
      throw new Error(`Build stopped: a secret would reach the browser.\n  - ${problems.join("\n  - ")}`);
    }
  }
  return nextConfig;
}
