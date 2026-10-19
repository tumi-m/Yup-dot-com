import type { Metadata } from "next";
import { getAccount } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { MarketingNav } from "@/components/MarketingNav";
import { RedeemFlow } from "@/components/TesterAccess";
import { loginHref } from "@/components/auth-redirect";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Tester access",
  robots: { index: false, follow: false },
};

/**
 * Where a tester link lands: /redeem#K7QM-8XRP-2D4N-W9HC. The code is only
 * ever in the fragment, which never reaches the server; a script at the top
 * of every page (app/layout.tsx) takes it out of the address bar before
 * anything else runs, analytics included.
 */
export default async function RedeemPage() {
  const account = await getAccount().catch(() => null);
  return (
    <div className="flex min-h-screen flex-col">
      {account ? (
        <AppNav plan={account.profile.plan} email={account.profile.email} billing={account.profile.billing} />
      ) : (
        <MarketingNav isAuthed={false} loginHref={loginHref("/redeem")} />
      )}
      <main id="main" className="container max-w-md flex-1 py-12 sm:py-16">
        <h1 className="text-3xl font-bold tracking-tight">Tester access</h1>
        <RedeemFlow signedIn={!!account} />
      </main>
    </div>
  );
}
