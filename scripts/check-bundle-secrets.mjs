#!/usr/bin/env node
/**
 * Fails if a server secret ended up in what browsers download.
 *
 * Build with a recognisable fake value in every server-only variable, then
 * run this: it searches the client bundle (.next/static), public/ and the
 * prerendered pages (.next/server/**.html|.rsc|.body|.meta) for each value.
 * As a positive control, the public anon key must be found in the bundle,
 * so a broken search can't pass.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=canary_service_role_8f3a ... npx next build
 *   node scripts/check-bundle-secrets.mjs
 *
 * CI sets the values (see .github/workflows/ci.yml).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SERVER_ONLY = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYSTACK_SECRET_KEY",
  "PAYSTACK_PLAN_PRO",
  "PAYSTACK_PLAN_TEAM",
  "OLLAMA_API_KEY",
  "OLLAMA_HOST",
  "USAGE_HASH_SALT",
  "MEDIA_WORKER_SECRET",
  "MEDIA_SIGNING_SECRET",
];
const PUBLIC_CONTROL = "NEXT_PUBLIC_SUPABASE_ANON_KEY";

const secrets = SERVER_ONLY.map((name) => [name, process.env[name]?.trim()]).filter(([, v]) => v && v.length >= 8);
const control = process.env[PUBLIC_CONTROL]?.trim();
if (secrets.length < 3 || !control) {
  console.error(
    `Build and run this with fake values in at least SUPABASE_SERVICE_ROLE_KEY, PAYSTACK_SECRET_KEY, MEDIA_SIGNING_SECRET and ${PUBLIC_CONTROL}.`
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

const prerendered = (p) => /\.(html|rsc|body|meta|json)$/.test(p);
const targets = [...files(".next/static"), ...files("public"), ...files(".next/server", prerendered)];
if (!targets.some((p) => p.startsWith(join(".next", "static")))) {
  console.error("No .next/static: run `next build` first.");
  process.exit(2);
}

const leaks = [];
let controlFound = false;
for (const path of targets) {
  const text = readFileSync(path).toString("latin1");
  if (!controlFound && path.startsWith(join(".next", "static")) && text.includes(control)) controlFound = true;
  for (const [name, value] of secrets) if (text.includes(value)) leaks.push(`${name} in ${path}`);
}

if (!controlFound) {
  console.error(`Positive control failed: ${PUBLIC_CONTROL} was not found in .next/static, so the search can't be trusted.`);
  process.exit(1);
}
if (leaks.length) {
  console.error(`Server secrets found in browser-facing files:\n  ${leaks.join("\n  ")}`);
  process.exit(1);
}
console.log(`No server secret in ${targets.length} browser-facing files (${secrets.map(([n]) => n).join(", ")}).`);
