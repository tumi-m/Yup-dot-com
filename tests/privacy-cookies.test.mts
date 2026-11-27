// The privacy page said the sign-in cookies last "up to 400 days", but the
// app caps them at 30; it didn't list the cookie that holds an email link
// until Continue, nor the tab storage that keeps a tester link's code, nor
// the card fingerprint kept for a subscription. It now says what the code does.
import { readFileSync } from "node:fs";
import { AUTH_COOKIE_OPTIONS } from "../lib/supabase/config.ts";
import { PENDING_LINK_COOKIE } from "../lib/auth-callback.ts";
import { TESTER_CODE_KEY } from "../lib/tester-access.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const page = readFileSync(new URL("../app/privacy/page.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");

const days = AUTH_COOKIE_OPTIONS.maxAge / 86400;
check(`sign-in cookies: the page says ${days} days, as the app sets them`, page.includes(`last ${days} days after your last visit`) && !/400 days/.test(page));
check("the email link cookie is listed, with how long it lasts", page.includes(`<strong>${PENDING_LINK_COOKIE}</strong>`) && /up to an hour/.test(page));
check("so is the tester code's tab storage", page.includes(`<strong>${TESTER_CODE_KEY}</strong>`));
check("the card fingerprint a subscription keeps is named",
  /create table if not exists public\.subscription_starts/.test(schema) && /fingerprint of the card authorization/.test(page));
check("tester code use is named", /<h3>Tester codes<\/h3>/.test(page));

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll privacy page checks passed.");
