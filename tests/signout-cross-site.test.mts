// Any website could sign a visitor out: a form on another site that posts to
// /auth/signout cleared the session cookies. The site's own sign-out button
// (a plain form post) still works.
process.env.NEXT_PUBLIC_SITE_URL = "https://pdfwizard.test";
import { POST } from "../app/auth/signout/route.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const post = (headers: Record<string, string>) =>
  POST(new Request("http://localhost:3405/auth/signout", { method: "POST", headers: { host: "localhost:3405", ...headers }, body: "" }));

const evil = await post({ ...FORM, origin: "http://127.0.0.1:3409", "sec-fetch-site": "cross-site" });
check("another site's form is refused", evil.status === 403 && !evil.headers.get("set-cookie"), evil.status);
const noFetchMeta = await post({ ...FORM, origin: "https://evil.example" });
check("another site's Origin is refused without Sec-Fetch-Site", noFetchMeta.status === 403, noFetchMeta.status);

const own = await post({ ...FORM, origin: "http://localhost:3405", "sec-fetch-site": "same-origin" });
check("the site's own sign-out button works", own.status === 303 && new URL(own.headers.get("location")!).pathname === "/", own.status);
const proxied = await post({ ...FORM, origin: "https://pdfwizard.test", "x-forwarded-host": "pdfwizard.test" });
check("behind a proxy too", proxied.status === 303, proxied.status);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sign-out checks passed.");
