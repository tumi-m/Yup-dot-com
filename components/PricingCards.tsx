"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { PLAN_LIST } from "@/lib/plans";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PlanId } from "@/lib/types";

export function PricingCards({
  isAuthed,
  currentPlan,
}: {
  isAuthed: boolean;
  currentPlan?: PlanId;
}) {
  const router = useRouter();
  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(plan: PlanId) {
    setError(null);
    if (!isAuthed) {
      router.push(`/signup?redirect=/pricing`);
      return;
    }
    if (plan === "free") {
      router.push("/dashboard");
      return;
    }
    setLoadingPlan(plan);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Checkout failed.");
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoadingPlan(null);
    }
  }

  return (
    <div>
      {error && (
        <p className="mx-auto mb-6 max-w-md rounded-lg bg-destructive/10 px-4 py-3 text-center text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-3">
        {PLAN_LIST.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          return (
            <div
              key={plan.id}
              className={cn(
                "flex flex-col rounded-2xl border bg-card p-8",
                plan.highlighted
                  ? "border-primary shadow-lg ring-1 ring-primary"
                  : "border-border"
              )}
            >
              {plan.highlighted && (
                <span className="mb-3 self-start rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
                  Most popular
                </span>
              )}
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {plan.description}
              </p>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-bold">${plan.priceMonthly}</span>
                <span className="text-muted-foreground">/mo</span>
              </div>

              <ul className="mt-6 flex-1 space-y-3 text-sm">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <Button
                className="mt-8"
                variant={plan.highlighted ? "default" : "outline"}
                disabled={isCurrent || loadingPlan === plan.id}
                onClick={() => choose(plan.id)}
              >
                {loadingPlan === plan.id && <Loader2 className="animate-spin" />}
                {isCurrent
                  ? "Current plan"
                  : plan.id === "free"
                    ? "Get started"
                    : `Upgrade to ${plan.name}`}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
