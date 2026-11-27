// Log in, sign up, Forgot password and the new password page showed
// Supabase's words as they came: "Failed to fetch" when it couldn't be
// reached, and, with the README's "letters and digits" rule, "Password should
// contain at least one character of each: abcdefghijklmnopqrstuvwxyzABCD…",
// which ran out of the form on a phone, under a hint that only asked for 10
// characters. Forgot password and sign-up also told which emails have an
// account: only a real one meets a mail limit or a failing mail server. And
// the submit button was disabled while the security check fetched a new
// token, dropping the focus on it. These are the errors supabase-js itself
// makes from each answer.
import { createClient } from "@supabase/supabase-js";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT, authFailure, newPasswordFailure, revealsAccount, submitState, type AuthMode } from "../components/auth-redirect.ts";

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
check("a short password: the rule, as the hint says it",
  (await signup({ status: 422, body: { code: 422, error_code: "weak_password", msg: short, weak_password: { reasons: ["length"] } } })) === weakSaid);

const tooMany = await login({ status: 429, body: { code: 429, error_code: "over_request_rate_limit", msg: "Request rate limit reached" } });
check("too many log-in tries: says to wait", tooMany === "Too many tries. Wait a few minutes, then try again.", tooMany);
const wrong = await login({ status: 400, body: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" } });
check("a wrong password is still the usual answer", /^Wrong email or password/.test(wrong), wrong);

const same = authFailure((await supabase({ status: 422, body: { code: 422, error_code: "same_password", msg: "New password should be different from the old password." } }).signUp({ email: "a@x.co", password: "x" })).error);
check("the same password again: plain", same === "That's your current password. Choose a new one.", same);

// ---------- What each form shows: the form calls revealsAccount, then authFailure ----------
const NEUTRAL = "(the form's usual message)";
async function formSays(mode: AuthMode, answer: Answer) {
  const a = supabase(answer);
  const { error } =
    mode === "reset" ? await a.resetPasswordForEmail("a@x.co")
    : mode === "signup" ? await a.signUp({ email: "a@x.co", password: "abcdefghij1" })
    : await a.signInWithPassword({ email: "a@x.co", password: "abcdefghij1" });
  return !error || revealsAccount(error, mode) ? NEUTRAL : authFailure(error);
}
const goTrue = (status: number, code: string, msg: string) => ({ status, body: { code: status, error_code: code, msg } });

// Forgot password: Supabase answers an unknown email 200 at once and sends
// nothing, so only a known one can meet a mail limit or a failing mail
// server. Those answers told which emails have an account.
for (const [what, answer] of [
  ["an unknown email", { status: 200, body: {} }],
  ["a known email asked again within a minute", goTrue(429, "over_email_send_rate_limit", "For security purposes, you can only request this after 47 seconds.")],
  ["a known email past the project's email limit", goTrue(429, "over_email_send_rate_limit", "email rate limit exceeded")],
  ["a known email when the mail server fails", goTrue(500, "unexpected_failure", "Error sending recovery email")],
] as [string, Answer][]) {
  check(`Forgot password, ${what}: the usual message`, (await formSays("reset", answer)) === NEUTRAL, await formSays("reset", answer));
}
// Sign-up: a confirmed account gets the usual answer and nothing is sent;
// only a new or unconfirmed address meets a mail limit or failure.
for (const [what, answer] of [
  ["an unconfirmed address asked again within a minute", goTrue(429, "over_email_send_rate_limit", "For security purposes, you can only request this after 52 seconds.")],
  ["the mail server failing", goTrue(500, "unexpected_failure", "Error sending confirmation email")],
  ["an address that has an account", goTrue(422, "user_already_exists", "User already registered")],
] as [string, Answer][]) {
  check(`Sign-up, ${what}: the usual message`, (await formSays("signup", answer)) === NEUTRAL, await formSays("signup", answer));
}
// Refusals made before the email is looked up are said, in plain words.
const before: [AuthMode, string, Answer, string][] = [
  ["login", "the security check ran out", goTrue(400, "captcha_failed", "captcha protection: request disallowed (timeout-or-duplicate)"), "The security check ran out. Wait for it to finish again, then try again."],
  ["reset", "the security check ran out", goTrue(400, "captcha_failed", "captcha protection: request disallowed (timeout-or-duplicate)"), "The security check ran out. Wait for it to finish again, then try again."],
  ["signup", "an email that isn't one", goTrue(400, "validation_failed", "Unable to validate email address: invalid format"), "Enter a valid email address."],
  ["reset", "an email that isn't one", goTrue(400, "validation_failed", "Unable to validate email address: invalid format"), "Enter a valid email address."],
  ["signup", "a refused email domain", goTrue(400, "email_address_invalid", 'Email address "a@x.co" is invalid'), "Enter a valid email address."],
  ["signup", "sign-ups switched off", goTrue(422, "signup_disabled", "Signups not allowed for this instance"), "New accounts can't be made right now. Try again later."],
  ["signup", "a weak password", goTrue(422, "weak_password", "Password should be at least 10 characters."), weakSaid],
  ["reset", "no connection", "offline", OFFLINE],
];
for (const [mode, what, answer, said] of before) {
  check(`${mode}, ${what}: "${said}"`, (await formSays(mode, answer)) === said, await formSays(mode, answer));
}
check("an answer nobody planned for: a plain sentence, not Supabase's words",
  (await formSays("login", goTrue(400, "something_new", "internal: flow_state not found"))) === "Something went wrong. Try again.");

// ---------- The new password page ----------
const anon = createClient("http://127.0.0.1:54321", "anon-key", { auth: { persistSession: false, autoRefreshToken: false } }).auth;
const gone = newPasswordFailure((await anon.updateUser({ password: "abcdefghij1" })).error);
check("session gone: says to log in again, not \"Auth session missing!\"", /signed out/.test(gone.message) && gone.field === null, gone);
const weakNew = newPasswordFailure((await supabase(goTrue(422, "weak_password", "Password should be at least 10 characters.")).signUp({ email: "a@x.co", password: "x" })).error);
check("a weak new password marks the new password field", weakNew.field === "new" && weakNew.message === weakSaid, weakNew);
const sameNew = newPasswordFailure((await supabase(goTrue(422, "same_password", "New password should be different from the old password.")).signUp({ email: "a@x.co", password: "x" })).error);
check("so does the old password again", sameNew.field === "new", sameNew);
const reauth = newPasswordFailure((await supabase(goTrue(400, "reauthentication_needed", "Password update requires reauthentication.")).signUp({ email: "a@x.co", password: "x" })).error);
check("Secure password change: log in again first", /log in again first/.test(reauth.message) && reauth.field === null, reauth);

// ---------- The submit button while the security check has no token ----------
// It starts again after every answer, so after "Wrong email or password" the
// button was disabled for a moment and the focus on it was lost.
const waiting = submitState({ configured: true, loading: false, captcha: true, token: null });
check("waiting for the security check: aria-disabled, not disabled, and a press does nothing",
  waiting.ariaDisabled && !waiting.disabled && waiting.blocked, waiting);
const ready = submitState({ configured: true, loading: false, captcha: true, token: "tok" });
check("with a token: ready", !ready.ariaDisabled && !ready.disabled && !ready.blocked, ready);
const busy = submitState({ configured: true, loading: true, captcha: false, token: null });
check("while a request runs: aria-disabled, a second press does nothing", busy.ariaDisabled && !busy.disabled && busy.blocked, busy);
const off = submitState({ configured: false, loading: false, captcha: false, token: null });
check("without Supabase: disabled", off.disabled && off.blocked, off);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll sign-in error checks passed.");
