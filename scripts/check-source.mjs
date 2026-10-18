#!/usr/bin/env node
/**
 * Runs before every build (npm "prebuild", so on Vercel too) and in the
 * tests, and stops the build when the code itself would put a secret in the
 * browser (rules in lib/secret-scan.cjs):
 *
 * - a NEXT_PUBLIC_ variable the code uses that isn't on the list of public
 *   variables (PUBLIC_VARS). Next.js copies each one the code names into
 *   every visitor's browser, whatever it holds;
 * - a hard-coded credential: a name like password, adminPass, ADMIN_PW,
 *   token or apiKey compared with, or set to, a fixed string. That is the
 *   admin password from the 2026 MyBroadband story, in the page's code;
 * - a secret key pasted into app code or public/ (Supabase service_role or
 *   sb_secret_, Paystack/Stripe sk_, private keys, OpenAI, Resend, GitHub,
 *   AWS, connection strings with a password, also base64 or hex encoded).
 *
 * next.config.ts runs the same check for a plain `next build`. The whole
 * repository and its history are also scanned with gitleaks in CI.
 *
 *   node scripts/check-source.mjs [project dir]
 */
import { resolve } from "node:path";
import secretScan from "../lib/secret-scan.cjs";

const { problems, files } = secretScan.sourceProblems(resolve(process.argv[2] ?? "."));
if (problems.length) {
  console.error(["", "Build stopped: the code would put a secret in the browser.", ...problems.map((p) => `  - ${p}`), ""].join("\n"));
  process.exit(1);
}
console.log(`Source check: ${files} files, no hard-coded credential or secret key, and only listed NEXT_PUBLIC_ variables.`);
