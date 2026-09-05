import { Suspense } from "react";
import { MarketingNav } from "@/components/MarketingNav";
import { PricingCards } from "@/components/PricingCards";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const user = await getCurrentUser();
  const profile = user ? await getProfile() : null;

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main className="container flex-1 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            Simple, honest pricing
          </h1>
          <p className="mt-3 text-muted-foreground">
            Start free. Upgrade when you need more. Cancel anytime.
          </p>
        </div>
        <div className="mt-14">
          <Suspense>
            <PricingCards isAuthed={!!user} currentPlan={profile?.plan} />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
