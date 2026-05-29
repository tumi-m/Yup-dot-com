import { redirect } from "next/navigation";
import { getProfile } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { PricingCards } from "@/components/PricingCards";
import { ManageBillingButton } from "@/components/BillingClient";
import { PLANS } from "@/lib/plans";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login?redirect=/settings/billing");

  const plan = PLANS[profile.plan];
  const isPaid = profile.plan !== "free";

  return (
    <div className="min-h-screen">
      <AppNav plan={profile.plan} email={profile.email} />
      <main className="container py-10">
        <h1 className="text-3xl font-bold tracking-tight">Billing</h1>

        <div className="mt-6 rounded-2xl border border-border bg-card p-6">
          <p className="text-sm text-muted-foreground">Current plan</p>
          <div className="mt-1 flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold">{plan.name}</p>
              <p className="text-sm text-muted-foreground">{plan.description}</p>
            </div>
            <p className="text-right text-lg font-semibold">
              ${plan.priceMonthly}
              <span className="text-sm font-normal text-muted-foreground">/mo</span>
            </p>
          </div>
          {isPaid && (
            <div className="mt-5 border-t border-border pt-5">
              <ManageBillingButton />
            </div>
          )}
        </div>

        <h2 className="mt-12 text-xl font-semibold">
          {isPaid ? "Change plan" : "Upgrade your plan"}
        </h2>
        <div className="mt-6">
          <Suspense>
            <PricingCards isAuthed currentPlan={profile.plan} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
