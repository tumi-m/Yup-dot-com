// Log in, sign up, Forgot password, the new password page, Manage
// subscription, Extend and Add (team seats) disabled their button while they worked. A
// disabled button drops the focus it has, so after "Wrong email or password"
// (or any answer) a keyboard user was back at the top of the page. They are
// aria-disabled now (focus stays, a second press does nothing), and the
// error is tied to the fields it is about.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExtendButtons, ManageBillingButton, TeamSeats } from "../components/BillingClient.tsx";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// What the button does while working or waiting for the security check is
// submitState's (tests/auth-errors.test.mts); the form must use all of it.
const auth = src("components/AuthForm.tsx");
check("auth form: the submit button takes submitState's disabled and aria-disabled",
  /disabled=\{submit\.disabled\} aria-disabled=\{submit\.ariaDisabled \|\| undefined\}/.test(auth) && !/(?<!aria-)disabled=\{loading/.test(auth));
check("auth form: a press while it is blocked does nothing", /if \(submit\.blocked\) return;/.test(auth));
check("auth form: the error has an id the fields point to", /id="auth-error"/.test(auth) && (auth.match(/"auth-error"/g) ?? []).length >= 3);

const password = src("components/PasswordForm.tsx");
check("new password: the button keeps focus while saving", !/(?<!aria-)disabled=\{busy\}/.test(password) && /aria-disabled=\{busy \|\| undefined\}/.test(password) && /if \(busy\) return;/.test(password));
check("new password: the error is tied to the fields, and a mismatch marks the second one",
  /id="password-error"/.test(password) && /aria-invalid=\{invalid === "confirm"/.test(password) && /aria-invalid=\{invalid === "new"/.test(password));

const billing = src("components/BillingClient.tsx");
check("Manage subscription and Extend aren't disabled while they work", !/(?<!aria-)disabled=\{loading/.test(billing) && /if \(loading\) return;/.test(billing) && /if \(loading !== null\) return;/.test(billing));
check("team seats: Add keeps focus while it works, and a new email clears the last answer",
  /aria-disabled=\{busy !== null \|\| undefined\}>\s*\{busy === "add"/.test(billing) && /setEmail\(e\.target\.value\);\s*\/\/[^\n]*\n\s*setError\(null\);/.test(billing));
const seats = renderToStaticMarkup(createElement(TeamSeats, { ownerEmail: "o@x.co", initialMembers: [], seats: 5 }));
check("team seats: the email field points at the error's place", /id="team-error"/.test(seats) && !/ disabled=""/.test(seats));
const manage = renderToStaticMarkup(createElement(ManageBillingButton));
const extend = renderToStaticMarkup(createElement(ExtendButtons, { plan: "pro" }));
check("and both render enabled at rest", !/ (aria-)?disabled=/.test(manage) && !/ (aria-)?disabled=/.test(extend), { manage, extend });

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll account focus checks passed.");
