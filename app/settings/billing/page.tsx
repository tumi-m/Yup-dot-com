import { redirect } from "next/navigation";
import { getAccount } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { PricingCards } from "@/components/PricingCards";
import {
  ExtendButtons,
  ManageBillingButton,
  PaymentReturn,
  TeamSeats,
} from "@/components/BillingClient";
import { PLANS, TEAM_SEATS, formatPrice } from "@/lib/plans";
import { ownPlan } from "@/lib/billing";
import { planStatus } from "@/lib/billing-ui";
import { isAdminConfigured, listTeamMembers } from "@/lib/billing-store";
import { isOurReference } from "@/lib/paystack";
import { displayPrice } from "@/lib/currency";
import { getPriceDisplay } from "@/lib/local-prices";
import { loginHref } from "@/components/auth-redirect";

export const dynamic = "force-dynamic";
export const metadata = { title: "Billing" };

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; reference?: string; currency?: string }>;
}) {
  const sp = await searchParams;
  const reference = [sp.ref, sp.reference].find(isOurReference) ?? null;
  const account = await getAccount();
  // Back here after login, still confirming the payment.
  if (!account) redirect(loginHref(reference ? `/settings/billing?ref=${reference}` : "/settings/billing"));
  const { profile, row } = account;
  const { billing } = profile;
  const display = await getPriceDisplay(sp.currency);

  const plan = PLANS[profile.plan];
  const sub = billing.subscription;
  const prepaid = billing.prepaid;
  const ownsTeam = ownPlan(row, new Date()) === "team";
  // Listed after a Team plan ends too, so they can be removed: the emails
  // are kept, and get Team again if the owner renews it.
  const members = isAdminConfigured()
    ? (await listTeamMembers(profile.id).catch(() => [])).map((m) => m.email)
    : [];

  const status = planStatus(billing);

  return (
    <div className="min-h-screen">
      <AppNav plan={profile.plan} email={profile.email} />
      <main id="main" className="container max-w-5xl py-10">
        <h1 className="text-3xl font-bold tracking-tight">Billing</h1>

        {reference && <PaymentReturn key={reference} reference={reference} planName={plan.name} />}

        <section className="mt-6 rounded-2xl border border-border bg-card p-6" data-testid="current-plan">
          <p className="text-sm text-muted-foreground">Current plan</p>
          <div className="mt-1 flex items-center justify-between gap-4">
            <div>
              <p className="text-2xl font-bold">{plan.name}</p>
              {status.map((line) => (
                <p key={line} className="text-sm text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
            {billing.source !== "team" && (
              <div className="text-right">
                <p className="text-lg font-semibold">
                  {displayPrice(display, plan.priceMonthly)}
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                </p>
                {!display.local && plan.priceMonthly > 0 && (
                  <p className="text-xs text-muted-foreground">Billed as {formatPrice(plan.priceMonthly)}</p>
                )}
              </div>
            )}
          </div>

          {sub?.pastDue && sub.active && (
            <div className="mt-5 rounded-xl bg-destructive/10 p-4 text-sm">
              <p className="font-medium text-destructive">
                Payment failed. Update your card to keep {PLANS[sub.plan].name}.
              </p>
              <div className="mt-3">
                <ManageBillingButton label="Update card" variant="default" />
              </div>
            </div>
          )}

          {(sub?.manageable && !sub.pastDue) || (billing.source === "prepaid" && prepaid) ? (
            <div className="mt-5 space-y-4 border-t border-border pt-5">
              {sub?.manageable && !sub.pastDue && <ManageBillingButton />}
              {billing.source === "prepaid" && prepaid && <ExtendButtons plan={prepaid.plan} display={display} />}
            </div>
          ) : null}
        </section>

        {(ownsTeam || members.length > 0) && (
          <section className="mt-10">
            <TeamSeats ownerEmail={profile.email} initialMembers={members} seats={TEAM_SEATS} ended={!ownsTeam} />
          </section>
        )}

        {!sub?.active && billing.source !== "prepaid" && (
          <>
            <h2 className="mt-12 text-xl font-semibold">Upgrade</h2>
            <div className="mt-6">
              <PricingCards isAuthed currentPlan={profile.plan} billing={billing} display={display} />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
