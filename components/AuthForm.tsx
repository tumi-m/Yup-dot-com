"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
  createClient,
  isSupabaseConfigured,
  NOT_CONFIGURED_MESSAGE,
} from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WizardWordmark } from "@/components/WizardLogo";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") || "/dashboard";

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

    try {
      if (isSignup) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { full_name: fullName },
            emailRedirectTo:
              typeof window !== "undefined"
                ? `${window.location.origin}/auth/callback`
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-secondary/40 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-8 shadow-sm">
        <Link href="/" className="mb-6 flex justify-center text-lg">
          <WizardWordmark />
        </Link>
        <h1 className="text-center text-2xl font-bold">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          {isSignup ? "Start editing PDFs for free." : "Log in to your account."}
        </p>

        {!isSupabaseConfigured() && (
          <p className="mt-6 rounded-md bg-amber-100 px-3 py-2 text-sm text-amber-900">
            {NOT_CONFIGURED_MESSAGE}{" "}
            <Link href="/tools" className="font-medium underline">
              Browse the tools
            </Link>
          </p>
        )}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {isSignup && (
            <Input
              type="text"
              placeholder="Full name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
            />
          )}
          <Input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={isSignup ? "new-password" : "current-password"}
          />

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {message && (
            <p className="rounded-md bg-accent px-3 py-2 text-sm text-accent-foreground">
              {message}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={loading || !isSupabaseConfigured()}
          >
            {loading && <Loader2 className="animate-spin" />}
            {isSignup ? "Sign up" : "Log in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isSignup ? "Already have an account? " : "Don't have an account? "}
          <Link
            href={isSignup ? "/login" : "/signup"}
            className="font-medium text-primary hover:underline"
          >
            {isSignup ? "Log in" : "Sign up"}
          </Link>
        </p>
      </div>
    </div>
  );
}
