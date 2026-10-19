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
import { TesterCodeEntry } from "@/components/TesterAccess";
import { PLANS, TEAM_SEATS, formatBillingDate, formatPrice } from "@/lib/plans";
import { ownPlan } from "@/lib/billing";
import { planStatus, planTitle } from "@/lib/billing-ui";
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
  // Tester access is free: no price, and buying stays possible but tucked away.
  // The question is about when all of it ends (Pro time can follow Team time).
  const tester = billing.source === "tester" && billing.tester ? (billing.tester.then ?? billing.tester) : null;
  const paying = billing.source === "subscription" || billing.source === "prepaid" || billing.source === null;
  const cards = <PricingCards isAuthed currentPlan={profile.plan} billing={billing} display={display} />;

  return (
    <div className="min-h-screen">
      <AppNav plan={profile.plan} email={profile.email} billing={profile.billing} />
      <main id="main" className="container max-w-5xl py-10">
        <h1 className="text-3xl font-bold tracking-tight">Billing</h1>

        {reference && <PaymentReturn key={reference} reference={reference} />}

        <section className="mt-6 rounded-2xl border border-border bg-card p-6" data-testid="current-plan">
          <p className="text-sm text-muted-foreground">Current plan</p>
          <div className="mt-1 flex items-center justify-between gap-4">
            <div>
              <p className="text-2xl font-bold">{planTitle(billing)}</p>
              {status.map((line) => (
                <p key={line} className="text-sm text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
            {paying && (
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

          {sub?.pastDue && sub.live && (
            <div className="mt-5 rounded-xl bg-destructive/10 p-4 text-sm">
              <p className="font-medium text-destructive">
                {sub.active
                  ? `Payment failed. Update your card to keep ${PLANS[sub.plan].name}.`
                  : `Payment failed, so ${PLANS[sub.plan].name} is paused. Update your card to get it back.`}
              </p>
              <div className="mt-3">
                <ManageBillingButton label="Update card" variant="default" />
              </div>
            </div>
          )}

          {sub?.manageable || (billing.base.source === "prepaid" && prepaid) ? (
            <div className="mt-5 space-y-4 border-t border-border pt-5">
              {sub?.manageable && <ManageBillingButton />}
              {billing.base.source === "prepaid" && prepaid && <ExtendButtons plan={prepaid.plan} display={display} />}
            </div>
          ) : null}
        </section>

        <TesterCodeEntry />

        {(ownsTeam || members.length > 0) && (
          <section className="mt-10">
            <TeamSeats ownerEmail={profile.email} initialMembers={members} seats={TEAM_SEATS} ended={!ownsTeam} />
          </section>
        )}

        {!sub?.active && !sub?.live && billing.base.source !== "prepaid" &&
          (tester ? (
            <details className="group mt-10 rounded-2xl border border-border bg-card transition-shadow open:shadow-md" data-testid="tester-plans">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 font-medium [&::-webkit-details-marker]:hidden">
                Keep {PLANS[tester.plan].name} after {formatBillingDate(tester.until)}?
                <span aria-hidden className="text-xl leading-none text-primary transition-transform duration-base ease-in-out group-open:rotate-45 motion-reduce:transition-none">+</span>
              </summary>
              {/* Room above for the Most popular label, which sits over the card's edge. */}
              <div className="px-5 pb-6 pt-8">{cards}</div>
            </details>
          ) : (
            <>
              <h2 className="mt-12 text-xl font-semibold">Upgrade</h2>
              <div className="mt-6">{cards}</div>
            </>
          ))}
      </main>
    </div>
  );
}
