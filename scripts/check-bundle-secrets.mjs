#!/usr/bin/env node
/**
 * Fails if a server secret ended up in what browsers can download: the
 * client bundle (.next/static), public/, and prerendered pages
 * (.next/server/**.html|.rsc|.body|.meta|.json). Runs after every build
 * (npm "postbuild", so on Vercel too).
 *
 * It looks for two things (rules in lib/secret-scan.cjs):
 * - secret patterns: Supabase JWTs whose role isn't "anon" (service_role),
 *   sb_secret_ keys, Paystack sk_live_/sk_test_ keys, private keys;
 * - the actual values of the server-only variables set for this build
 *   (SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY, … and any other
 *   variable named like a secret), read the same way `next build` reads them.
 *
 * When NEXT_PUBLIC_SUPABASE_ANON_KEY is set, it must be found in
 * .next/static, so a search that reads nothing can't pass. With --canary
 * (CI), the build must also have fake values in at least three secrets,
 * so the search by value is really tested:
 *
 *   SUPABASE_SERVICE_ROLE_KEY=canary_service_role_8f3a ... npm run build
 *   node scripts/check-bundle-secrets.mjs --canary
 *
 * Pages rendered at request time aren't files here: React refuses to send
 * a secret to the browser (lib/server-secrets.ts), and
 * `npm run check:live -- <url> --env-values` checks the rendered pages.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import secretScan from "../lib/secret-scan.cjs";
import { loadBuildEnv } from "./build-env.mjs";

const PUBLIC_CONTROL = "NEXT_PUBLIC_SUPABASE_ANON_KEY";
const canary = process.argv.includes("--canary");

await loadBuildEnv();
const secrets = secretScan.serverValues(process.env);
const control = process.env[PUBLIC_CONTROL]?.trim();
if (canary && (secrets.length < 3 || !control)) {
  console.error(
    `--canary: build and run this with fake values in at least SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY, MEDIA_SIGNING_SECRET and ${PUBLIC_CONTROL}.`
  );
  process.exit(2);
}

function* files(dir, filter = () => true) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) yield* files(path, filter);
    else if (filter(path)) yield path;
  }
}

const STATIC = join(".next", "static") + sep;
const prerendered = (p) => /\.(html|rsc|body|meta|json)$/.test(p);
const targets = [...files(join(".next", "static")), ...files("public"), ...files(join(".next", "server"), prerendered)];
if (!targets.some((p) => p.startsWith(STATIC))) {
  console.error("No .next/static: run `next build` first.");
  process.exit(2);
}

const leaks = [];
let controlFound = false;
let bytes = 0;
for (const path of targets) {
  const text = readFileSync(path).toString("latin1");
  bytes += text.length;
  if (control && !controlFound && path.startsWith(STATIC) && text.includes(control)) controlFound = true;
  for (const { kind, sample } of secretScan.findSecrets(text)) leaks.push(`${path}: ${kind} (${sample})`);
  for (const [name, value] of secrets) if (text.includes(value)) leaks.push(`${path}: the value of ${name}`);
}

if (control && !controlFound) {
  console.error(`Positive control failed: ${PUBLIC_CONTROL} was not found in .next/static, so the search can't be trusted.`);
  process.exit(1);
}
if (leaks.length) {
  console.error(
    [
      "",
      "Build stopped: a server secret is in files that browsers can download.",
      ...leaks.slice(0, 20).map((l) => `  - ${l}`),
      ...(leaks.length > 20 ? [`  … and ${leaks.length - 20} more`] : []),
      "Remove it from client code, public/ or NEXT_PUBLIC_ variables, rebuild, and rotate the key if it was ever deployed (SECURITY.md).",
      "",
    ].join("\n")
  );
  process.exit(1);
}
const names = secrets.map(([n]) => n);
console.log(
  `Bundle check: no server secret in ${targets.length} browser-facing files (${(bytes / 1e6).toFixed(0)} MB; ` +
    `patterns${names.length ? `, values of ${names.join(", ")}` : ""}).`
);
