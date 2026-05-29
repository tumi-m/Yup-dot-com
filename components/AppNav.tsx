import Link from "next/link";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlanId } from "@/lib/types";

export function AppNav({ plan, email }: { plan: PlanId; email: string }) {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 backdrop-blur">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold text-lg">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FileText className="h-4 w-4" />
          </span>
          Yup
        </Link>

        <div className="flex items-center gap-3 text-sm">
          <span className="hidden rounded-full bg-accent px-3 py-1 text-xs font-medium uppercase tracking-wide text-accent-foreground sm:inline">
            {plan}
          </span>
          <Link
            href="/settings/billing"
            className="hidden text-muted-foreground hover:text-foreground sm:inline"
          >
            Billing
          </Link>
          <span className="hidden text-muted-foreground md:inline">{email}</span>
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
