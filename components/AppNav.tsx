"use client";

import { Button } from "@/components/ui/button";
import { NavShell, type NavLink } from "@/components/MarketingNav";
import { PLANS } from "@/lib/plans";
import type { PlanId } from "@/lib/types";

const LINKS: NavLink[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/tools", label: "Tools" },
  { href: "/settings/billing", label: "Billing" },
];

function PlanBadge({ plan }: { plan: PlanId }) {
  return (
    <span className="rounded-full bg-gradient-to-r from-primary to-fuchsia-500 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
      {PLANS[plan]?.name ?? plan}
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
export function AppNav({ plan, email }: { plan: PlanId; email: string }) {
  return (
    <NavShell
      homeHref="/dashboard"
      links={LINKS}
      actions={
        <>
          <PlanBadge plan={plan} />
          <SignOut />
        </>
      }
      mobileTop={
        <div className="flex items-center justify-between gap-3 px-3 pb-2">
          <span className="min-w-0 truncate text-sm text-muted-foreground">{email}</span>
          <PlanBadge plan={plan} />
        </div>
      }
      mobileActions={<SignOut className="h-11 w-full" />}
    />
  );
}
