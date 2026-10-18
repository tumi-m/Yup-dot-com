#!/usr/bin/env node
/**
 * Runs before every build (npm "prebuild", so on Vercel too) and stops it
 * when a NEXT_PUBLIC_ variable would put a server secret in the browser
 * bundle: a Supabase service_role JWT or sb_secret_ key, a Paystack
 * sk_live_/sk_test_ key, a private key, the value of a server-only variable,
 * or a server-only name (NEXT_PUBLIC_PAYSTACK_SECRET_KEY). The anon or
 * publishable key and pk_ keys are fine. next.config.ts runs the same check
 * for a plain `next build`. Rules: lib/secret-scan.cjs.
 *
 *   node scripts/check-env.mjs
 */
import secretScan from "../lib/secret-scan.cjs";
import { loadBuildEnv } from "./build-env.mjs";

await loadBuildEnv();
const problems = secretScan.envProblems(process.env);
if (problems.length) {
  console.error(
    [
      "",
      "Build stopped: a secret would reach the browser.",
      ...problems.map((p) => `  - ${p}`),
      "Fix it in Vercel → Project → Settings → Environment Variables (or your .env file), then build again.",
      "If this value was ever deployed, rotate the key too (SECURITY.md, \"If a key leaks\").",
      "",
    ].join("\n")
  );
  process.exit(1);
}
console.log("Environment check: no server secret in a NEXT_PUBLIC_ variable.");
