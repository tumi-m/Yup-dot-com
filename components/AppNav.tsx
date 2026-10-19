"use client";

import { Button } from "@/components/ui/button";
import { NavShell, type NavLink } from "@/components/MarketingNav";
import { planBadge } from "@/lib/billing-ui";
import type { BillingSummary } from "@/lib/billing";
import type { PlanId } from "@/lib/types";

const LINKS: NavLink[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/tools", label: "Tools" },
  { href: "/settings/billing", label: "Billing" },
];

function PlanBadge({ plan, billing, full = false }: { plan: PlanId; billing?: BillingSummary; full?: boolean }) {
  const { name, until } = planBadge(plan, billing);
  return (
    <span className="flex items-center gap-2" data-testid="plan-badge">
      {/* Ends on fuchsia-700: white text stays above 4.5:1 across the whole pill. */}
      <span className="whitespace-nowrap rounded-full bg-gradient-to-r from-primary to-fuchsia-700 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
        {name}
      </span>
      {/* Tester time: the end date beside the pill, from lg up in the header. */}
      {until && <span className={full ? "whitespace-nowrap text-xs text-muted-foreground" : "hidden whitespace-nowrap text-xs text-muted-foreground lg:inline"}>{until}</span>}
    </span>
  );
}

function SignOut({ className }: { className?: string }) {
  return (
    <form action="/auth/signout" method="post">
      <Button type="submit" variant="outline" size="sm" className={className}>
        Sign out
      </Button>
    </form>
  );
}

/** The signed-in header: same chrome as the marketing pages. */
export function AppNav({ plan, email, billing }: { plan: PlanId; email: string; billing?: BillingSummary }) {
  return (
    <NavShell
      homeHref="/dashboard"
      links={LINKS}
      actions={
        <>
          <PlanBadge plan={plan} billing={billing} />
          <SignOut />
        </>
      }
      mobileTop={
        <div className="flex items-center justify-between gap-3 px-3 pb-2">
          <span className="min-w-0 truncate text-sm text-muted-foreground">{email}</span>
          <PlanBadge plan={plan} billing={billing} full />
        </div>
      }
      mobileActions={<SignOut className="h-11 w-full" />}
    />
  );
}
