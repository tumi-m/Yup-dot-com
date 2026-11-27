// Log in, sign up, Forgot password and the new password page showed
// Supabase's words as they came: "Failed to fetch" when it couldn't be
// reached, and, with the README's "letters and digits" rule, "Password should
// contain at least one character of each: abcdefghijklmnopqrstuvwxyzABCD…",
// which ran out of the form on a phone, under a hint that only asked for 10
// characters. These are the errors supabase-js itself makes from each answer.
import { createClient } from "@supabase/supabase-js";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT, authFailure } from "../components/auth-redirect.ts";

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail !== "" ? ` (${JSON.stringify(detail)})` : ""}`);
  if (!ok) failed++;
}

// supabase-js logs every failed fetch: not this test's output.
console.error = () => {};

type Answer = { status: number; body: unknown } | "offline";
/** A Supabase client whose Auth server gives `answer` to everything. */
function supabase(answer: Answer) {
  return createClient("http://127.0.0.1:54321", "anon-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (async () => {
        if (answer === "offline") throw new TypeError("Failed to fetch");
        const text = typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
        return new Response(text, { status: answer.status, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    },
  }).auth;
}
const login = async (answer: Answer) => authFailure((await supabase(answer).signInWithPassword({ email: "a@x.co", password: "pw" })).error);
const signup = async (answer: Answer) => authFailure((await supabase(answer).signUp({ email: "a@x.co", password: "onlyletters" })).error);
const reset = async (answer: Answer) => authFailure((await supabase(answer).resetPasswordForEmail("a@x.co")).error);

const OFFLINE = "Couldn't reach PDF Wizard. Check your connection and try again.";
for (const [what, answer] of [
  ["no connection", "offline"],
  ["Supabase down (503)", { status: 503, body: {} }],
  ["a gateway's error page", { status: 500, body: "<html><h1>Bad gateway</h1></html>" }],
] as [string, Answer][]) {
  check(`${what}: log in says to check the connection`, (await login(answer)) === OFFLINE, await login(answer));
  check(`${what}: so do sign-up and Forgot password`, (await signup(answer)) === OFFLINE && (await reset(answer)) === OFFLINE);
}
const broken = await login({ status: 500, body: { code: 500, error_code: "unexpected_failure", msg: "Unexpected failure, please check server logs for more information" } });
check("Supabase failing: says so, without its words", broken === "Sign-in isn't working right now. Try again in a few minutes.", broken);

const weak = { status: 422, body: { code: 422, error_code: "weak_password", msg: "Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789", weak_password: { reasons: ["characters"] } } };
const weakSaid = await signup(weak);
check("letters and digits required: said plainly", weakSaid === `Use at least ${MIN_PASSWORD_LENGTH} characters, with letters and numbers.`, weakSaid);
check("…with no character lists", !/abcdef|0123456789/.test(weakSaid));
check("the hint asks for the same before anyone tries", PASSWORD_HINT === `At least ${MIN_PASSWORD_LENGTH} characters, with letters and numbers.`, PASSWORD_HINT);
const pwned = await signup({ status: 422, body: { code: 422, error_code: "weak_password", msg: "Password is known to be weak and easy to guess, please choose a different one.", weak_password: { reasons: ["pwned"] } } });
check("a leaked password: says why and what to do", /data leak/.test(pwned) && /Choose another/.test(pwned), pwned);
const short = "Password should be at least 10 characters.";
check("a short password: Supabase's own plain words",
  (await signup({ status: 422, body: { code: 422, error_code: "weak_password", msg: short, weak_password: { reasons: ["length"] } } })) === short);

const tooMany = await login({ status: 429, body: { code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" } });
check("too many log-in tries: says to wait", tooMany === "Too many tries. Wait a few minutes, then try again.", tooMany);
const wrong = await login({ status: 400, body: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" } });
check("a wrong password is still the usual answer", /^Wrong email or password/.test(wrong), wrong);

const same = authFailure((await supabase({ status: 422, body: { code: 422, error_code: "same_password", msg: "New password should be different from the old password." } }).signUp({ email: "a@x.co", password: "x" })).error);
check("the same password again: plain", same === "That's your current password. Choose a new one.", same);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sign-in error checks passed.");
