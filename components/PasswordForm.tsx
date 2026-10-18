"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence } from "motion/react";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/motion/primitives";

/**
 * Sets a new password for the signed-in account (after a reset link, too),
 * then links on to `next` when logging in started somewhere.
 */
export function PasswordForm({ next }: { next?: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) throw error;
      setSaved(true);
      setPassword("");
      setConfirm("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-3 rounded-2xl border border-border bg-card p-6">
      <div>
        <label htmlFor="new-password" className="text-sm font-medium">New password</label>
        <Input
          id="new-password"
          className="mt-1.5 h-11"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          autoComplete="new-password"
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="text-sm font-medium">Type it again</label>
        <Input
          id="confirm-password"
          className="mt-1.5 h-11"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={6}
          autoComplete="new-password"
        />
      </div>
      <AnimatePresence>{error && <InlineError key="error" message={error} />}</AnimatePresence>
      {saved && (
        <p role="status" className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground motion-safe:animate-rise">
          Password saved.{" "}
          <Link href={next || "/dashboard"} className="font-medium underline underline-offset-2">
            {next ? "Continue" : "Go to your documents"}
          </Link>
        </p>
      )}
      <Button type="submit" className="h-11 w-full" disabled={busy}>
        {busy && <Loader2 className="motion-safe:animate-spin" />}
        Save password
      </Button>
    </form>
  );
}
