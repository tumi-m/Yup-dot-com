// The guest card on a finished task linked to plain /signup, so signing up
// landed on the dashboard instead of the tool, and it promised to save the
// result, which nothing did.
import { readFileSync } from "node:fs";
import { safeRedirect, signupHref } from "../components/auth-redirect.ts";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && extra !== undefined ? `  → ${JSON.stringify(extra)}` : ""}`);
}

const href = signupHref("/tools/compress-pdf");
check("links back to the tool", href === "/signup?redirect=%2Ftools%2Fcompress-pdf", href);
const back = safeRedirect(new URLSearchParams(href.split("?")[1]).get("redirect"));
check("and the sign-up page goes there", back === "/tools/compress-pdf", back);
check("with a query", signupHref("/tools/tiktok-to-mp4?url=a&b=c") === "/signup?redirect=%2Ftools%2Ftiktok-to-mp4%3Furl%3Da%26b%3Dc");
check("nowhere to return to", signupHref() === "/signup" && signupHref("") === "/signup");

const src = readFileSync(new URL("../components/upsell/Upsell.tsx", import.meta.url), "utf8");
check("the card doesn't promise to save this result", !/Save your work/.test(src));
check("no plain /signup links", !/href="\/signup"/.test(src));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
