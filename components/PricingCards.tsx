"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { PLAN_LIST, formatPrice, isPaidPlan, prepaidPrice } from "@/lib/plans";
import { displayPrice, type PriceDisplay } from "@/lib/currency";
import { startCheckout, type CheckoutRequest } from "@/components/BillingClient";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlanId } from "@/lib/types";

const loadingKey = (r: CheckoutRequest) => `${r.plan}:${r.mode === "once" ? r.months : "subscription"}`;

export function PricingCards({
  isAuthed,
  currentPlan,
  display,
}: {
  isAuthed: boolean;
  currentPlan?: PlanId;
  /** Local-currency strings; rand when absent. Checkout always bills rand. */
  display?: PriceDisplay;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  /** A failed checkout, shown in the card whose button was pressed. */
  const [error, setError] = useState<{ plan: PlanId; message: string } | null>(null);

  async function choose(plan: PlanId, req?: CheckoutRequest) {
    setError(null);
    const pressed = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The free plan needs no account at all — send people straight to the tools.
    if (plan === "free") {
      router.push(isAuthed ? "/dashboard" : "/tools");
      return;
    }
    if (!isAuthed) {
      router.push(`/signup?redirect=/pricing`);
      return;
    }
    const body = req ?? { plan, mode: "subscription" };
    const key = loadingKey(body);
    setLoading(key);
    const err = await startCheckout(body);
    if (err) {
      setError({ plan, message: err });
      setLoading(null);
      // The button was disabled while loading, which dropped focus; give it back.
      requestAnimationFrame(() => pressed?.isConnected && pressed.focus());
    }
  }

  return (
    <div>
      {/* One column below lg: three columns at tablet width squeeze every
          feature onto two lines. */}
      <div className="mx-auto grid max-w-md items-stretch gap-6 lg:max-w-none lg:grid-cols-3">
        {PLAN_LIST.map((plan, i) => {
          const isCurrent = currentPlan === plan.id;
          return (
            <div key={plan.id} className="motion-safe:animate-rise" style={{ animationDelay: `${i * 0.06}s` }}>
              <div
                className={cn(
                  "relative flex h-full flex-col rounded-3xl border bg-card p-8 transition-[transform,box-shadow] duration-300 ease-out hover:-translate-y-[3px] motion-reduce:transform-none",
                  plan.highlighted
                    ? "border-transparent shadow-2xl shadow-primary/20 lg:-my-3 lg:py-11"
                    : "border-border hover:shadow-lg"
                )}
              >
                {plan.highlighted && (
                  <>
                    {/* Gradient border; the angle turns, the shape never moves. */}
                    <span aria-hidden className="pricing-ring" />
                    <span className="absolute -top-3 left-8 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-md shadow-primary/30">
                      Most popular
                    </span>
                  </>
                )}
                <h2 className="text-xl font-semibold">{plan.name}</h2>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="text-4xl font-bold">{displayPrice(display, plan.priceMonthly)}</span>
                  <span className="text-muted-foreground">/mo</span>
                </div>
                {/* Reserved in every card so the feature lists line up. */}
                {display && !display.local && (
                  <p className="mt-1 min-h-4 text-xs leading-4 text-muted-foreground">
                    {plan.priceMonthly > 0 ? `Billed as ${formatPrice(plan.priceMonthly)}` : null}
                  </p>
                )}

                <ul className="mt-6 flex-1 space-y-3 text-sm">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  className="mt-8 h-11"
                  variant={plan.highlighted ? "default" : "outline"}
                  disabled={isCurrent || loading !== null}
                  onClick={() => choose(plan.id)}
                >
                  {loading === `${plan.id}:subscription` && <Loader2 className="animate-spin" />}
                  {isCurrent
                    ? "Current plan"
                    : plan.id === "free"
                      ? "Start free"
                      : `Upgrade to ${plan.name}`}
                </Button>
                {/* Kept in every card (empty on Free) so the buttons line up. */}
                <div className="mt-2 flex min-h-11 flex-wrap items-center justify-center gap-x-1 text-xs text-muted-foreground">
                  {isPaidPlan(plan.id) && !isCurrent && (
                    <>
                      <span className="whitespace-nowrap">Pay once:</span>
                      {([1, 12] as const).map((months) => {
                        const req: CheckoutRequest = { plan: plan.id as "pro" | "team", mode: "once", months };
                        return (
                          <button
                            key={months}
                            type="button"
                            disabled={loading !== null}
                            onClick={() => choose(plan.id, req)}
                            title={display && !display.local ? `Billed as ${formatPrice(prepaidPrice(req.plan, months))}` : undefined}
                            className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap rounded-lg px-2 font-medium text-foreground underline-offset-2 transition-colors hover:bg-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          >
                            {loading === loadingKey(req) && <Loader2 className="h-3 w-3 animate-spin" />}
                            {months === 1 ? "1 month" : "1 year"} {displayPrice(display, prepaidPrice(req.plan, months))}
                            {months === 12 && (
                              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                                2 months free
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
                {error?.plan === plan.id && (
                  <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-4 py-3 text-center text-sm text-destructive">
                    {error.message}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Monthly plans renew until cancelled.{" "}
        <Link href="/refunds" className="inline-flex min-h-11 items-center rounded font-medium text-foreground underline underline-offset-2 hover:text-primary">
          Refund policy
        </Link>
      </p>
    </div>
  );
}
