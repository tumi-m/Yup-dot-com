"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ENTER, ENTER_T, FADE_EXIT, InlineError, SuccessBadge } from "@/components/motion/primitives";
import { loginHref, signupHref } from "@/components/auth-redirect";
import { PLANS, formatBillingDate } from "@/lib/plans";
import {
  REDEEM_UNAVAILABLE,
  TESTER_CODE_EVENT,
  forgetTesterCode,
  formatTesterCode,
  parseRedeemResult,
  takeTesterCode,
  type CodeWindow,
  type RedeemResult,
} from "@/lib/tester-access";

type Answer =
  | { ok: true; result: RedeemResult }
  | { ok: false; status: number; error: string; reason: string | null };

/** POST /api/access/redeem. `check` asks what the code gives without using it. */
async function redeem(code: string, check = false): Promise<Answer> {
  try {
    const res = await fetch("/api/access/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, check }),
      cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    const result = res.ok ? parseRedeemResult(data) : null;
    if (result) return { ok: true, result };
    return {
      ok: false,
      status: res.status,
      error: typeof data.error === "string" ? data.error : REDEEM_UNAVAILABLE,
      reason: typeof data.reason === "string" ? data.reason : null,
    };
  } catch {
    return { ok: false, status: 0, error: "You're offline. Check your connection.", reason: null };
  }
}

/** The server answered about the code itself (not a hiccup): a saved code is no use any more. */
const settled = (a: Answer) => a.ok || (a.status === 400 && a.reason !== null);

const codeWindow = () => window as unknown as CodeWindow;

/** "Pro is on" and when it ends. */
function Activated({ result, compact = false }: { result: RedeemResult; compact?: boolean }) {
  const name = PLANS[result.plan].name;
  return (
    <div role="status" className={compact ? "flex items-center gap-4" : "text-center"}>
      <SuccessBadge size={compact ? 48 : 64} className={compact ? "mx-0" : undefined} />
      <div className={compact ? undefined : "mt-5"}>
        <p className="text-lg font-semibold">{name} is on</p>
        <p className="text-sm text-muted-foreground" data-testid="tester-until">
          Free until {formatBillingDate(result.until)}.
        </p>
      </div>
    </div>
  );
}

/**
 * A field for a tester code and one button. Used on /redeem when there is
 * no link, and on the Billing page.
 */
export function TesterCodeForm({
  initialCode = "",
  initialError = null,
  autoFocus = false,
  onRedeemed,
}: {
  initialCode?: string;
  initialError?: string | null;
  autoFocus?: boolean;
  onRedeemed: (result: RedeemResult) => void;
}) {
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [tries, setTries] = useState(0);
  const field = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const tidy = formatTesterCode(code);
    if (!tidy) {
      setError("A code has 16 letters and numbers, like K7QM-8XRP-2D4N-W9HC.");
      setTries((n) => n + 1);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const answer = await redeem(tidy);
    setBusy(false);
    if (answer.ok) {
      forgetTesterCode(codeWindow());
      onRedeemed(answer.result);
      return;
    }
    if (settled(answer)) forgetTesterCode(codeWindow());
    setError(answer.error);
    setTries((n) => n + 1);
    requestAnimationFrame(() => field.current?.focus());
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="flex gap-2">
        <label htmlFor="tester-code" className="sr-only">
          Tester code
        </label>
        <Input
          id="tester-code"
          ref={field}
          className="h-11 font-mono uppercase tracking-wider placeholder:font-sans placeholder:normal-case placeholder:tracking-normal"
          placeholder="Tester code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "tester-code-error" : undefined}
        />
        <Button type="submit" className="h-11 shrink-0" disabled={busy}>
          {busy && <Loader2 className="motion-safe:animate-spin" />}
          Activate
        </Button>
      </div>
      <div id="tester-code-error">
        <AnimatePresence>{error && <InlineError key="error" message={error} shakeKey={tries} />}</AnimatePresence>
      </div>
    </form>
  );
}

type Phase =
  | { kind: "start" }
  | { kind: "signed-out"; hasCode: boolean }
  | { kind: "checking" }
  | { kind: "ready"; code: string; offer: RedeemResult }
  | { kind: "enter"; code: string; error: string | null }
  | { kind: "done"; result: RedeemResult };

/**
 * /redeem. The link's code was moved out of the address bar before the page
 * loaded (REDEEM_FRAGMENT_SCRIPT); this reads it from the tab's storage.
 * Signed out: one line and the way to sign up or log in, which come back
 * here (the code waits in this tab). Signed in: what the code gives and one
 * button, then a calm success.
 */
export function RedeemFlow({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "start" });
  const [activating, setActivating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when another link is opened in this tab (only the fragment changed). */
  const [link, setLink] = useState(0);

  useEffect(() => {
    const again = () => setLink((n) => n + 1);
    // The inline script's event, or the fragment itself when it didn't run
    // (this page reached by a client-side navigation).
    window.addEventListener(TESTER_CODE_EVENT, again);
    const onHash = () => location.hash.length > 1 && !document.getElementById(location.hash.slice(1)) && again();
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener(TESTER_CODE_EVENT, again);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const raw = takeTesterCode(codeWindow());
    if (!signedIn) {
      setPhase({ kind: "signed-out", hasCode: !!raw });
      return;
    }
    if (!raw) {
      setPhase({ kind: "enter", code: "", error: null });
      return;
    }
    const code = formatTesterCode(raw);
    if (!code) {
      forgetTesterCode(codeWindow());
      setPhase({ kind: "enter", code: "", error: "That link's code isn't complete. Paste the code instead." });
      return;
    }
    setPhase({ kind: "checking" });
    redeem(code, true).then((answer) => {
      if (cancelled) return;
      if (answer.ok) setPhase({ kind: "ready", code, offer: answer.result });
      else if (answer.status === 401) setPhase({ kind: "signed-out", hasCode: true });
      else {
        if (settled(answer)) forgetTesterCode(codeWindow());
        setPhase({ kind: "enter", code: settled(answer) ? "" : code, error: answer.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn, link]);

  function done(result: RedeemResult) {
    setPhase({ kind: "done", result });
    // The header's plan badge and every page after this see the new plan.
    router.refresh();
  }

  async function activate(code: string) {
    if (activating) return;
    setActivating(true);
    setError(null);
    const answer = await redeem(code);
    setActivating(false);
    if (answer.ok) {
      forgetTesterCode(codeWindow());
      done(answer.result);
    } else if (settled(answer)) {
      forgetTesterCode(codeWindow());
      setPhase({ kind: "enter", code: "", error: answer.error });
    } else {
      setError(answer.error);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card p-6" data-testid="redeem">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={phase.kind} data-phase={phase.kind} initial={ENTER.initial} animate={ENTER.animate} exit={FADE_EXIT}>
          {phase.kind === "start" || phase.kind === "checking" ? (
            <p className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground" role="status">
              {phase.kind === "checking" && <Loader2 className="h-4 w-4 text-primary motion-safe:animate-spin" />}
              {phase.kind === "checking" ? "Checking your code…" : " "}
            </p>
          ) : phase.kind === "signed-out" ? (
            <>
              <p>
                {phase.hasCode
                  ? "Sign up or log in to use your tester code."
                  : "Sign up or log in, then enter your tester code."}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button asChild className="h-11 px-6">
                  <Link href={signupHref("/redeem")}>Sign up</Link>
                </Button>
                <Button asChild variant="outline" className="h-11 px-6">
                  <Link href={loginHref("/redeem")}>Log in</Link>
                </Button>
              </div>
            </>
          ) : phase.kind === "ready" ? (
            <>
              <p>
                {PLANS[phase.offer.plan].name}, free until{" "}
                <span className="font-medium">{formatBillingDate(phase.offer.until)}</span>.
              </p>
              <Button className="mt-5 h-11 w-full" onClick={() => activate(phase.code)} disabled={activating}>
                {activating && <Loader2 className="motion-safe:animate-spin" />}
                Activate {PLANS[phase.offer.plan].name}
              </Button>
              <AnimatePresence>{error && <InlineError key="error" message={error} className="mt-3" />}</AnimatePresence>
            </>
          ) : phase.kind === "enter" ? (
            <>
              <p className="mb-4 text-sm text-muted-foreground">
                Paste your tester code, or open your tester link again.
              </p>
              <TesterCodeForm initialCode={phase.code} initialError={phase.error} autoFocus onRedeemed={done} />
            </>
          ) : (
            <>
              <Activated result={phase.result} />
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button asChild className="h-11 px-6">
                  <Link href="/tools">Open the tools</Link>
                </Button>
                <Button asChild variant="outline" className="h-11 px-6">
                  <Link href="/settings/billing">Billing</Link>
                </Button>
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** "Have a tester code?" on the Billing page: opens the same form in place. */
export function TesterCodeEntry() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RedeemResult | null>(null);

  return (
    <div className="mt-4" data-testid="tester-entry">
      <AnimatePresence mode="wait" initial={false}>
        {result ? (
          <motion.div key="done" initial={ENTER.initial} animate={ENTER.animate} transition={ENTER_T}>
            <Activated result={result} compact />
          </motion.div>
        ) : open ? (
          <motion.div key="form" initial={ENTER.initial} animate={ENTER.animate} exit={FADE_EXIT} className="max-w-md">
            <TesterCodeForm
              autoFocus
              onRedeemed={(r) => {
                setResult(r);
                router.refresh();
              }}
            />
          </motion.div>
        ) : (
          <motion.div key="link" exit={FADE_EXIT}>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="tap inline-flex min-h-11 items-center rounded text-sm font-medium text-primary hover:underline"
            >
              Have a tester code?
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
