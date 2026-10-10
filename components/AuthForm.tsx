"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WizardWordmark } from "@/components/WizardLogo";
import { Aurora, Starfield } from "@/components/landing/HeroScene";
import { safeRedirect } from "@/components/auth-redirect";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isSignup = mode === "signup";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);
    const supabase = createClient();
    // Read at submit time, so the page needs no search-params boundary and
    // the whole form is in the static HTML.
    const redirectTo = safeRedirect(new URLSearchParams(window.location.search).get("redirect"));

    try {
      if (isSignup) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo:
              typeof window !== "undefined"
                ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectTo)}`
                : undefined,
          },
        });
        if (error) throw error;
        // If email confirmation is disabled the session exists immediately.
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.push(redirectTo);
          router.refresh();
        } else {
          setMessage("Check your email to confirm your account, then log in.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        router.push(redirectTo);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
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
          {isSignup ? "Create account" : "Log in"}
        </h1>

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
              minLength={6}
              autoComplete={isSignup ? "new-password" : "current-password"}
            />
          </div>

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

          <Button type="submit" className="h-11 w-full" disabled={loading || !configured}>
            {loading && <Loader2 className="animate-spin" />}
            {isSignup ? "Sign up" : "Log in"}
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
          {isSignup ? "Already have an account? " : "Don't have an account? "}
          <Link
            href={isSignup ? "/login" : "/signup"}
            className="inline-flex h-11 items-center rounded font-medium text-primary hover:underline"
          >
            {isSignup ? "Log in" : "Sign up"}
          </Link>
        </p>
      </div>
    </main>
  );
}
