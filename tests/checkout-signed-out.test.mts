// With Pricing or Billing open after the session ended (signed out in
// another tab, or it ran out), Upgrade, Pay once, Extend and Manage
// subscription answered "Log in first." in the card, with the header still
// showing Dashboard: a dead end. They now go to log in, and back to the page.
import { loginHref } from "../components/auth-redirect.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

const location = { href: "http://localhost/pricing?currency=EUR", pathname: "/pricing", search: "?currency=EUR" };
Object.assign(globalThis, { window: { location } });
let answer: { status: number; body: unknown } = { status: 401, body: { error: "Log in first." } };
globalThis.fetch = (async () => new Response(JSON.stringify(answer.body), { status: answer.status })) as typeof fetch;
const { startCheckout } = await import("../components/BillingClient.tsx");

const said = await startCheckout({ plan: "pro", mode: "subscription" });
check("signed out: no dead-end message in the card", said === null, said);
check("…it goes to log in, and back to this page after", location.href === loginHref("/pricing?currency=EUR"), location.href);

location.href = "http://localhost/pricing";
answer = { status: 409, body: { error: "You already subscribe to Pro." } };
const refused = await startCheckout({ plan: "pro", mode: "once", months: 1 });
check("other refusals are still said in the card", refused === "You already subscribe to Pro." && location.href === "http://localhost/pricing", refused);

answer = { status: 200, body: { url: "https://checkout.paystack.com/abc" } };
check("a checkout still opens", (await startCheckout({ plan: "team", mode: "subscription" })) === null && location.href === "https://checkout.paystack.com/abc");

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll signed-out checkout checks passed.");
