// The privacy page said the sign-in cookies last "up to 400 days", but the
// app caps them at 30, and its list of what the site keeps in the browser
// missed the cookie that holds an email link until Continue, a tester
// link's code, the tool hand-off note, and the Smaller file and editor
// shortcut choices. The list is now checked against the code: every cookie
// the app sets and every key it keeps in browser storage must be named.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AUTH_COOKIE_OPTIONS } from "../lib/supabase/config.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const root = new URL("..", import.meta.url).pathname;
const page = readFileSync(join(root, "app/privacy/page.tsx"), "utf8").replace(/\s+/g, " ");
const named = new Set([...page.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]));

function sources(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return sources(rel);
    return /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
}
const files = ["app", "components", "lib"].flatMap(sources);

// Browser storage: the string constants a file that uses localStorage,
// sessionStorage or IndexedDB keeps as its key (or database) names.
const storageKeys = new Map<string, string>();
for (const file of files) {
  const src = readFileSync(join(root, file), "utf8");
  if (!/\b(localStorage|sessionStorage|indexedDB)\b/.test(src)) continue;
  for (const m of src.matchAll(/const ([A-Z_]*(?:KEY|DB_NAME)) = "([^"]+)"/g)) {
    // A property on window (the fallback when storage is blocked), not storage.
    if (m[2].startsWith("__")) continue;
    storageKeys.set(m[2], file);
  }
}
check("the scan finds the storage the app is known to use",
  ["pdfw-consent", "pw-usage", "pdf-wizard", "pdfw-tester-code"].every((k) => storageKeys.has(k)), [...storageKeys.keys()]);
for (const [key, file] of storageKeys) check(`browser storage "${key}" (${file}) is on the privacy page`, named.has(key));

// Cookies the app writes itself (Supabase's are named sb-…-auth-token).
for (const file of files) {
  const src = readFileSync(join(root, file), "utf8");
  for (const m of src.matchAll(/export const ([A-Z_]*COOKIE) = "([^"]+)"/g)) {
    check(`cookie "${m[2]}" (${file}) is on the privacy page`, named.has(m[2]));
  }
}
check("sign-in cookies are named", named.has("sb-…-auth-token"));

const days = AUTH_COOKIE_OPTIONS.maxAge / 86400;
check(`sign-in cookies: the page says ${days} days, as the app sets them`, page.includes(`last ${days} days after your last visit`) && !/400 days/.test(page));
check("the email link cookie says how long it lasts", /pw-email-link<\/strong> \(a cookie\)[^<]*up to an hour/.test(page));

const schema = readFileSync(join(root, "supabase/schema.sql"), "utf8");
check("the card fingerprint a subscription keeps is named",
  /create table if not exists public\.subscription_starts/.test(schema) && /fingerprint of the card authorization/.test(page));
check("tester code use is named", /<h3>Tester codes<\/h3>/.test(page));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll privacy page checks passed.");
