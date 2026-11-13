import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { EmailOtpType } from "@supabase/supabase-js";
import { Button } from "@/components/ui/button";
import { WizardWordmark } from "@/components/WizardLogo";
import { Aurora, Starfield } from "@/components/landing/HeroScene";
import { getCurrentUser } from "@/lib/supabase/server";
import { LINK_FIELD, PENDING_LINK_COOKIE, linkDigest, readPendingLink } from "@/lib/auth-callback";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Continue",
  robots: { index: false, follow: false },
};

const COPY: Record<EmailOtpType, { title: string; text: string }> = {
  recovery: { title: "Reset password", text: "Continue to choose a new password." },
  signup: { title: "Confirm your email", text: "Continue to finish signing up." },
  email: { title: "Confirm your email", text: "Continue to finish signing up." },
  invite: { title: "Accept invite", text: "Continue to log in." },
  magiclink: { title: "Log in", text: "Continue to log in." },
  email_change: { title: "Confirm new email", text: "Continue to confirm the change." },
};

/**
 * Where an email link with a token hash waits (lib/auth-callback.ts). The
 * token stays in an HttpOnly cookie, out of the address bar and analytics;
 * Continue posts it back to /auth/callback from this site, naming the link
 * this page showed.
 */
export default async function ConfirmLinkPage() {
  const link = readPendingLink((await cookies()).get(PENDING_LINK_COOKIE)?.value);
  // Gone (used, or older than an hour): the login page explains.
  if (!link) redirect("/login?error=auth");
  const user = await getCurrentUser();
  const copy = COPY[link.type];

  return (
    <main id="main" className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-primary/10 via-background to-background px-4">
      <Aurora />
      <Starfield />
      <div className="relative w-full max-w-sm rounded-3xl border border-border bg-card/95 p-8 shadow-2xl shadow-primary/10">
        <Link href="/" className="mx-auto mb-6 flex h-11 w-fit items-center rounded-lg text-lg">
          <WizardWordmark />
        </Link>
        <h1 className="text-center text-2xl font-bold">{copy.title}</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">{copy.text}</p>
        {user?.email && (
          <p className="mt-4 rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground">
            You&apos;re logged in as <span className="font-medium break-all">{user.email}</span>. If the link is for
            another account, you&apos;ll switch to that one.
          </p>
        )}
        <form method="post" action="/auth/callback" className="mt-6">
          <input type="hidden" name={LINK_FIELD} value={linkDigest(link)} />
          <Button type="submit" className="h-11 w-full">
            Continue
          </Button>
        </form>
        <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
          Didn&apos;t ask for this link? Close this page.
        </p>
      </div>
    </main>
  );
}
