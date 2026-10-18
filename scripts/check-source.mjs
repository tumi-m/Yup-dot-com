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
 * The whole repository and its history are also scanned with gitleaks in CI.
 *
 *   node scripts/check-source.mjs [project dir]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import secretScan from "../lib/secret-scan.cjs";

const root = resolve(process.argv[2] ?? ".");
const problems = [];

for (const [name, files] of secretScan.publicVarsInSource(root)) {
  if (!secretScan.isAllowedPublicName(name.slice("NEXT_PUBLIC_".length))) {
    problems.push(`${files[0]}: uses ${name}, which isn't on the list of public variables (PUBLIC_VARS in lib/secret-scan.cjs). Every NEXT_PUBLIC_ value the code names is sent to every visitor.`);
  }
}

const code = secretScan.sourceFiles(root);
for (const file of code) {
  const text = readFileSync(join(root, file), "utf8");
  if (file !== "lib/secret-scan.cjs") {
    for (const { line, what } of secretScan.credentialLiterals(text)) {
      problems.push(`${file}:${line}: ${what}. A password or key in the code can be read in the browser; check it on the server against a value it keeps secret.`);
    }
  }
  for (const { kind, sample } of secretScan.findSecrets(text)) problems.push(`${file}: ${kind} (${sample})`);
}
// public/vendor is third-party code copied in at build time; the post-build
// scan reads it with everything else browsers download.
const assets = secretScan
  .sourceFiles(root, ["public", "extension"], /\.(?:[cm]?js|json|html?|txt|css|svg|map|xml|webmanifest)$/)
  .filter((f) => !f.startsWith("public/vendor/"));
for (const file of assets) {
  for (const { kind, sample } of secretScan.findSecrets(readFileSync(join(root, file), "latin1"))) problems.push(`${file}: ${kind} (${sample})`);
}

if (problems.length) {
  console.error(["", "Build stopped: the code would put a secret in the browser.", ...problems.map((p) => `  - ${p}`), ""].join("\n"));
  process.exit(1);
}
console.log(`Source check: ${code.length + assets.length} files, no hard-coded credential or secret key, and only listed NEXT_PUBLIC_ variables.`);
