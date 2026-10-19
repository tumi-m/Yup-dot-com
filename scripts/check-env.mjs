#!/usr/bin/env node
/**
 * Runs before every build (npm "prebuild", so on Vercel too) and stops it
 * when a NEXT_PUBLIC_ variable would put a server secret in the browser
 * bundle: a name that says secret, password, token, API key, JWT or database
 * (NEXT_PUBLIC_ADMIN_PASSWORD, NEXT_PUBLIC_OPENAI_API_KEY), a server-only
 * name in any case, a value holding a key (Supabase service_role JWT or
 * sb_secret_, Paystack sk_, OpenAI, Resend, private keys, a connection
 * string with a password; also base64 or hex encoded), the value of a
 * server-only variable, or a NEXT_PUBLIC_ variable the code uses that isn't
 * on the public list. The anon or publishable key and pk_ keys are fine.
 * NEXT_PUBLIC_ variables nothing uses only get a warning: Next.js doesn't
 * put those in the bundle. next.config.ts runs the same check for a plain
 * `next build`. Rules: lib/secret-scan.cjs.
 *
 *   node scripts/check-env.mjs
 */
import secretScan from "../lib/secret-scan.cjs";
import { loadBuildEnv } from "./build-env.mjs";

await loadBuildEnv();
const used = new Set(secretScan.publicVarsInSource(process.cwd()).keys());
const problems = secretScan.envProblems(process.env, used);
for (const w of secretScan.envWarnings(process.env, used)) console.warn(`Environment check: ${w}`);
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
