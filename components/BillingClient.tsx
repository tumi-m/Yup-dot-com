"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, Loader2, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ENTER_T, EXIT_T, FADE_EXIT, InlineError, SPRING_LAYOUT, SuccessBadge } from "@/components/motion/primitives";
import { formatPrice, prepaidPrice, type PaidPlanId } from "@/lib/plans";
import { displayPrice, type PriceDisplay } from "@/lib/currency";
import { trackBeginCheckout, trackPurchase, type CheckoutChoice } from "@/lib/analytics";
import { paymentOutcome, waitForPayment, type PaymentOutcome } from "@/lib/billing-ui";
import { focusAfterRemove } from "@/components/list-focus";

export type CheckoutRequest =
  | { plan: PaidPlanId; mode: "subscription" }
  | { plan: PaidPlanId; mode: "once"; months: 1 | 12 };

/** Sends the browser to Paystack checkout. Resolves with an error message on failure. */
export async function startCheckout(body: CheckoutRequest): Promise<string | null> {
  trackBeginCheckout(body);
  try {
    const res = await fetch("/api/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) return data.error || "Checkout failed.";
    window.location.href = data.url;
    return null;
  } catch {
    return "You're offline. Check your connection.";
  }
}

/** Opens Paystack's page for updating the card or cancelling. */
export function ManageBillingButton({ label = "Manage subscription", variant = "outline" }: {
  label?: string;
  variant?: "outline" | "default";
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/manage", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || "Couldn't open subscription settings.");
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <div>
      <Button variant={variant} onClick={open} disabled={loading}>
        {loading ? <Loader2 className="motion-safe:animate-spin" /> : <ExternalLink />}
        {label}
      </Button>
      <AnimatePresence>{error && <InlineError key="error" compact message={error} className="mt-2 text-sm" />}</AnimatePresence>
    </div>
  );
}

/** Buy more prepaid time on the current plan. */
export function ExtendButtons({ plan, display }: { plan: PaidPlanId; display?: PriceDisplay }) {
  const [loading, setLoading] = useState<1 | 12 | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function extend(months: 1 | 12) {
    setLoading(months);
    setError(null);
    const err = await startCheckout({ plan, mode: "once", months });
    if (err) {
      setError(err);
      setLoading(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {([1, 12] as const).map((m) => (
          <Button key={m} variant={m === 12 ? "default" : "outline"} disabled={loading !== null} onClick={() => extend(m)}>
            {loading === m && <Loader2 className="motion-safe:animate-spin" />}
            Extend {m === 1 ? "1 month" : "1 year"} · {displayPrice(display, prepaidPrice(plan, m))}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground">
          1 year = 2 months free
          {display && !display.local && ` · billed as ${formatPrice(prepaidPrice(plan, 1))} / ${formatPrice(prepaidPrice(plan, 12))}`}
        </span>
      </div>
      <AnimatePresence>{error && <InlineError key="error" compact message={error} className="mt-2 text-sm" />}</AnimatePresence>
    </div>
  );
}

type VerifyState = "checking" | "pending" | Exclude<PaymentOutcome, "retry">;

/**
 * Shown on return from Paystack (?ref=…). Confirms the payment server-side,
 * then refreshes the page so the new plan shows.
 */
export function PaymentReturn({ reference, planName }: { reference: string; planName: string }) {
  const router = useRouter();
  const [state, setState] = useState<VerifyState>("checking");

  useEffect(() => {
    // Each run checks on its own; cleanup stops only this run's checks.
    let cancelled = false;
    let purchase: (CheckoutChoice & { amount?: number }) | null = null;
    async function verify(): Promise<PaymentOutcome> {
      try {
        const res = await fetch(`/api/billing/verify?reference=${encodeURIComponent(reference)}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        const outcome = paymentOutcome(res.status, data.status);
        if (outcome === "success") purchase = data.purchase ?? null;
        return outcome;
      } catch {
        return "retry"; // offline: try again
      }
    }
    // Waits while the tab is hidden, then checks as soon as it's back.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(function wake() {
          if (cancelled || !document.hidden) return resolve();
          document.addEventListener("visibilitychange", wake, { once: true });
        }, ms);
      });
    waitForPayment(verify, { sleep, stopped: () => cancelled, onPending: () => setState("pending") }).then((outcome) => {
      if (!outcome) return;
      if (outcome === "success" && purchase) trackPurchase(reference, purchase, purchase.amount);
      setState(outcome);
      if (outcome === "success") router.refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [reference, router]);

  function dismiss() {
    router.replace("/settings/billing", { scroll: false });
  }

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={state}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={FADE_EXIT}
        transition={ENTER_T}
        role="status"
        className="relative mt-6 flex items-center gap-4 rounded-2xl border border-border bg-card p-5"
      >
        {state === "checking" && (
          <>
            <Loader2 className="h-6 w-6 text-primary motion-safe:animate-spin" />
            <p className="font-medium">Confirming payment…</p>
          </>
        )}
        {state === "success" && (
          <>
            <SuccessBadge size={48} className="mx-0" />
            <div>
              <p className="text-lg font-semibold">Payment received</p>
              <p className="text-sm text-muted-foreground">You&apos;re on {planName}.</p>
            </div>
          </>
        )}
        {state === "pending" && (
          <p className="font-medium">Payment is still processing. This page updates once it clears.</p>
        )}
        {state === "failed" && (
          <p className="font-medium">Payment didn&apos;t go through. You weren&apos;t charged.</p>
        )}
        {state === "other-account" && (
          <p className="font-medium">
            This payment belongs to a different account. Sign in with the account you paid from.
          </p>
        )}
        {(state === "not-applied" || state === "unknown") && (
          <p className="font-medium">
            {state === "not-applied"
              ? "We received your payment but couldn't apply it."
              : "We couldn't confirm this payment. If you were charged,"}{" "}
            <Link href="/contact" className="underline underline-offset-2 hover:text-primary">
              {state === "not-applied" ? "Contact us" : "contact us"}
            </Link>{" "}
            with reference <span className="break-all font-mono text-sm">{reference}</span>.
          </p>
        )}
        {state !== "checking" && (
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="-my-2 -mr-2 ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );
}

/** Team owner's seat manager. */
export function TeamSeats({
  ownerEmail,
  initialMembers,
  seats,
}: {
  ownerEmail: string;
  initialMembers: string[];
  seats: number;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const used = members.length + 1;
  const full = used >= seats;
  const listRef = useRef<HTMLUListElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  /** After a member is removed: the next member's Remove, or "email" when none is left. */
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    const el =
      target === "email"
        ? emailRef.current
        : listRef.current?.querySelector<HTMLElement>(`[data-member="${CSS.escape(target)}"]`);
    el?.focus({ preventScroll: true });
  }, [members]);

  async function send(method: "POST" | "DELETE", value: string) {
    if (busy) return;
    // Removing a member takes its row and button away: focus moves on to the next one.
    const hadFocus = method === "DELETE" && !!listRef.current?.contains(document.activeElement);
    setBusy(method === "POST" ? "add" : value);
    setError(null);
    try {
      const res = await fetch("/api/billing/team", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't update seats.");
      const next = (data.members as { email: string }[]).map((m) => m.email);
      if (hadFocus) {
        const target = focusAfterRemove(members, value);
        focusAfter.current = target && next.includes(target) ? target : "email";
      }
      setMembers(next);
      if (method === "POST") setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">Team</h2>
        <p className="text-sm text-muted-foreground" data-testid="seat-usage">
          {used} of {seats} seats
        </p>
      </div>
      <ul ref={listRef} className="relative mt-4 divide-y divide-border rounded-2xl border border-border bg-card">
        <li className="flex items-center justify-between px-5 py-3 text-sm">
          <span>{ownerEmail}</span>
          <span className="text-muted-foreground">Owner</span>
        </li>
        <AnimatePresence initial={false} mode="popLayout">
          {members.map((m) => (
            <motion.li
              key={m}
              layout="position"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 24, transition: EXIT_T }}
              transition={{ ...ENTER_T, layout: SPRING_LAYOUT }}
              className="flex items-center justify-between px-5 py-3 text-sm"
            >
              <span>{m}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${m}`}
                data-member={m}
                // aria-disabled, not disabled: a disabled button drops the focus it has.
                aria-disabled={busy !== null}
                onClick={() => send("DELETE", m)}
              >
                {busy === m ? <Loader2 className="motion-safe:animate-spin" /> : <Trash2 />}
              </Button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {!full && (
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) send("POST", email.trim());
          }}
        >
          <Input
            ref={emailRef}
            type="email"
            required
            placeholder="colleague@company.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Member email"
          />
          <Button type="submit" disabled={busy !== null}>
            {busy === "add" ? <Loader2 className="motion-safe:animate-spin" /> : <UserPlus />}
            Add
          </Button>
        </form>
      )}
      <AnimatePresence>{error && <InlineError key="error" compact message={error} className="mt-2 text-sm" />}</AnimatePresence>
      <p className="mt-3 text-xs text-muted-foreground">Ask them to sign in with this email.</p>
    </div>
  );
}
