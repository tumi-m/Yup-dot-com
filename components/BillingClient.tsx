"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Check, ExternalLink, Loader2, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SPRING, SparkleBurst } from "@/components/motion/primitives";
import { formatPrice, prepaidPrice, type PaidPlanId } from "@/lib/plans";
import { displayPrice, type PriceDisplay } from "@/lib/currency";

export type CheckoutRequest =
  | { plan: PaidPlanId; mode: "subscription" }
  | { plan: PaidPlanId; mode: "once"; months: 1 | 12 };

/** Sends the browser to Paystack checkout. Resolves with an error message on failure. */
export async function startCheckout(body: CheckoutRequest): Promise<string | null> {
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
        {loading ? <Loader2 className="animate-spin" /> : <ExternalLink />}
        {label}
      </Button>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
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
            {loading === m && <Loader2 className="animate-spin" />}
            Extend {m === 1 ? "1 month" : "1 year"} · {displayPrice(display, prepaidPrice(plan, m))}
          </Button>
        ))}
        <span className="text-xs text-muted-foreground">
          1 year = 2 months free
          {display && !display.local && ` · billed as ${formatPrice(prepaidPrice(plan, 1))} / ${formatPrice(prepaidPrice(plan, 12))}`}
        </span>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  );
}

type VerifyState = "checking" | "success" | "failed" | "pending";

/**
 * Shown on return from Paystack (?ref=…). Confirms the payment server-side,
 * then refreshes the page so the new plan shows.
 */
export function PaymentReturn({ reference, planName }: { reference: string; planName: string }) {
  const router = useRouter();
  const [state, setState] = useState<VerifyState>("checking");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 8 && !cancelled; attempt++) {
        try {
          const res = await fetch(`/api/billing/verify?reference=${encodeURIComponent(reference)}`, { cache: "no-store" });
          const data = await res.json().catch(() => ({}));
          if (data.status === "success") {
            setState("success");
            router.refresh();
            return;
          }
          if (res.status !== 202 && data.status !== "ongoing" && data.status !== "pending" && data.status !== "processing") {
            setState("failed");
            return;
          }
        } catch {
          // offline: try again
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!cancelled) setState("pending");
    })();
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
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        role="status"
        className="relative mt-6 flex items-center gap-4 rounded-2xl border border-border bg-card p-5"
      >
        {state === "checking" && (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="font-medium">Confirming payment…</p>
          </>
        )}
        {state === "success" && (
          <>
            <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
              <SparkleBurst />
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={SPRING}
                className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
              >
                <Check className="h-6 w-6" />
              </motion.div>
            </div>
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
        {state !== "checking" && (
          <button onClick={dismiss} aria-label="Dismiss" className="ml-auto text-muted-foreground hover:text-foreground">
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

  async function send(method: "POST" | "DELETE", value: string) {
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
      setMembers((data.members as { email: string }[]).map((m) => m.email));
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
      <ul className="mt-4 divide-y divide-border rounded-2xl border border-border bg-card">
        <li className="flex items-center justify-between px-5 py-3 text-sm">
          <span>{ownerEmail}</span>
          <span className="text-muted-foreground">Owner</span>
        </li>
        <AnimatePresence initial={false}>
          {members.map((m) => (
            <motion.li
              key={m}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="flex items-center justify-between px-5 py-3 text-sm"
            >
              <span>{m}</span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${m}`}
                disabled={busy !== null}
                onClick={() => send("DELETE", m)}
              >
                {busy === m ? <Loader2 className="animate-spin" /> : <Trash2 />}
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
            type="email"
            required
            placeholder="colleague@company.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Member email"
          />
          <Button type="submit" disabled={busy !== null}>
            {busy === "add" ? <Loader2 className="animate-spin" /> : <UserPlus />}
            Add
          </Button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <p className="mt-3 text-xs text-muted-foreground">Ask them to sign in with this email.</p>
    </div>
  );
}
