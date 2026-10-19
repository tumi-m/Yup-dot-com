"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WizardWordmark } from "@/components/WizardLogo";
import { Aurora, Starfield } from "@/components/landing/HeroScene";
import {
  MIN_PASSWORD_LENGTH,
  authErrorMessage,
  authFailure,
  authSwitchHref,
  resetLinkTarget,
  revealsAccount,
  safeRedirect,
} from "@/components/auth-redirect";
import { Captcha, TURNSTILE_SITE_KEY } from "@/components/Captcha";
import { track } from "@/lib/analytics";

/** Log in, sign up, or ask for a link to reset a forgotten password. */
export function AuthForm({ mode }: { mode: "login" | "signup" | "reset" }) {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Cloudflare Turnstile, when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);

  const isSignup = mode === "signup";
  const isReset = mode === "reset";
  const otherPage = mode === "login" ? "/signup" : "/login";
  const [switchHref, setSwitchHref] = useState<string>(otherPage);
  const [forgotHref, setForgotHref] = useState("/forgot-password");

  // Read after load, like the submit handler, so the page stays static:
  // keep ?redirect on the links to the other pages, and explain a failed
  // confirmation link (?error=auth).
  useEffect(() => {
    const search = window.location.search;
    setSwitchHref(authSwitchHref(otherPage, search));
    setForgotHref(authSwitchHref("/forgot-password", search));
    const linkError = authErrorMessage(search);
    if (linkError) setError(linkError);
  }, [otherPage]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();
    // Read at submit time, so the page needs no search-params boundary and
    // the whole form is in the static HTML.
    const redirect = new URLSearchParams(window.location.search).get("redirect");
    const redirectTo = safeRedirect(redirect);
    const captcha = TURNSTILE_SITE_KEY ? { captchaToken: captchaToken ?? undefined } : {};

    try {
      if (isReset) {
        // The link signs them in and opens the page to choose a new password.
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: resetLinkTarget(window.location.origin, safeRedirect(redirect, "")),
          ...captcha,
        });
        // The same answer whether or not the email has an account.
        if (error && !revealsAccount(error, "reset")) throw error;
        setMessage("If an account uses that email, we've sent it a link to reset the password.");
      } else if (isSignup) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo:
              typeof window !== "undefined"
                ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`
                : undefined,
            ...captcha,
          },
        });
        // A tester's code waits only in this tab, and the email's link may
        // open another: their tester link brings it back.
        const checkEmail =
          redirectTo === "/redeem"
            ? "Check your email to confirm your account. Then open your tester link again."
            : "Check your email to confirm your account, then log in.";
        if (error) {
          // An email that already has an account gets the same answer as a new one.
          if (!revealsAccount(error, "signup")) throw error;
          setMessage(checkEmail);
          return;
        }
        track("sign_up", { method: "email" });
        // If email confirmation is disabled the session exists immediately.
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.push(redirectTo);
          router.refresh();
        } else {
          setMessage(checkEmail);
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
          options: captcha,
        });
        if (error) throw error;
        router.push(redirectTo);
        router.refresh();
      }
    } catch (err) {
      setError(authFailure(err));
    } finally {
      setLoading(false);
      // A Turnstile token works once.
      if (TURNSTILE_SITE_KEY) setCaptchaReset((n) => n + 1);
    }
  }

  const configured = isSupabaseConfigured();
  const field = "h-11";

  return (
    <main id="main" className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-primary/10 via-background to-background px-4">
      <Aurora />
      <Starfield />
      <div className="relative w-full max-w-sm rounded-3xl border border-border bg-card/95 p-8 shadow-2xl shadow-primary/10">
        <Link href="/" className="mx-auto mb-6 flex h-11 w-fit items-center rounded-lg text-lg">
          <WizardWordmark />
        </Link>
        <h1 className="text-center text-2xl font-bold">
          {isSignup ? "Create account" : isReset ? "Reset password" : "Log in"}
        </h1>
        {isReset && (
          <p className="mt-2 text-center text-sm text-muted-foreground">
            We&apos;ll email you a link to choose a new one.
          </p>
        )}

        {!configured && (
          <p className="mt-6 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900">
            Accounts are coming soon.{" "}
            <Link href="/tools" className="font-medium underline underline-offset-2">
              Browse the tools
            </Link>
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          {isSignup && (
            <div>
              <label htmlFor="auth-name" className="sr-only">Full name</label>
              <Input
                id="auth-name"
                className={field}
                type="text"
                placeholder="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoComplete="name"
              />
            </div>
          )}
          <div>
            <label htmlFor="auth-email" className="sr-only">Email</label>
            <Input
              id="auth-email"
              className={field}
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          {!isReset && (
            <div>
              <label htmlFor="auth-password" className="sr-only">Password</label>
              <Input
                id="auth-password"
                className={field}
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={isSignup ? MIN_PASSWORD_LENGTH : undefined}
                aria-describedby={isSignup ? "auth-password-hint" : undefined}
                autoComplete={isSignup ? "new-password" : "current-password"}
              />
              {isSignup && (
                <p id="auth-password-hint" className="mt-1.5 text-xs text-muted-foreground">
                  At least {MIN_PASSWORD_LENGTH} characters.
                </p>
              )}
              {!isSignup && (
                <div className="mt-2 flex justify-end">
                  <Link
                    href={forgotHref}
                    className="tap rounded text-sm font-medium text-primary hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive motion-safe:animate-rise">
              {error}
            </p>
          )}
          {message && (
            <p role="status" className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground motion-safe:animate-rise">
              {message}
            </p>
          )}

          {configured && <Captcha onToken={setCaptchaToken} resetKey={captchaReset} />}

          <Button type="submit" className="h-11 w-full" disabled={loading || !configured || (!!TURNSTILE_SITE_KEY && !captchaToken)}>
            {loading && <Loader2 className="motion-safe:animate-spin" />}
            {isSignup ? "Sign up" : isReset ? "Send link" : "Log in"}
          </Button>
          {isSignup && (
            <p className="text-center text-xs leading-5 text-muted-foreground">
              By creating an account you agree to the{" "}
              <Link href="/terms" className="tap whitespace-nowrap font-medium text-foreground underline underline-offset-2 hover:text-primary">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="tap whitespace-nowrap font-medium text-foreground underline underline-offset-2 hover:text-primary">
                Privacy Policy
              </Link>
              .
            </p>
          )}
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          {isSignup ? "Already have an account? " : isReset ? "Remembered it? " : "Don't have an account? "}
          <Link
            href={switchHref}
            className="inline-flex h-11 items-center rounded font-medium text-primary hover:underline"
          >
            {mode === "login" ? "Sign up" : "Log in"}
          </Link>
        </p>
      </div>
    </main>
  );
}
