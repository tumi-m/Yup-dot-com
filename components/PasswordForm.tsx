"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence } from "motion/react";
import { Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InlineError } from "@/components/motion/primitives";
import { MIN_PASSWORD_LENGTH, PASSWORD_HINT, newPasswordFailure } from "@/components/auth-redirect";

const MISMATCH = "The passwords don't match.";

/**
 * Sets a new password for the signed-in account (after a reset link, too),
 * then links on to `next` when logging in started somewhere.
 */
export function PasswordForm({ next }: { next?: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The field the error is about, marked aria-invalid. */
  const [invalid, setInvalid] = useState<"new" | "confirm" | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setInvalid(null);
    setSaved(false);
    if (password !== confirm) {
      setError(MISMATCH);
      setInvalid("confirm");
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
      const { message, field } = newPasswordFailure(err);
      setError(message);
      setInvalid(field);
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
          minLength={MIN_PASSWORD_LENGTH}
          aria-invalid={invalid === "new" || undefined}
          aria-describedby={error ? "new-password-hint password-error" : "new-password-hint"}
          autoComplete="new-password"
        />
        <p id="new-password-hint" className="mt-1.5 text-xs text-muted-foreground">
          {PASSWORD_HINT}
        </p>
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
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          aria-invalid={invalid === "confirm" || undefined}
          aria-describedby={error ? "password-error" : undefined}
        />
      </div>
      <div id="password-error">
        <AnimatePresence>{error && <InlineError key="error" message={error} />}</AnimatePresence>
      </div>
      {saved && (
        <p role="status" className="rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground motion-safe:animate-rise">
          Password saved.{" "}
          <Link href={next || "/dashboard"} className="font-medium underline underline-offset-2">
            {next ? "Continue" : "Go to your documents"}
          </Link>
        </p>
      )}
      {/* aria-disabled, not disabled: a disabled button drops the focus it has. */}
      <Button type="submit" className="h-11 w-full" aria-disabled={busy || undefined}>
        {busy && <Loader2 className="motion-safe:animate-spin" />}
        Save password
      </Button>
    </form>
  );
}
