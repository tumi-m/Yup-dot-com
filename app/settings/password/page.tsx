import { redirect } from "next/navigation";
import { getProfile } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { PasswordForm } from "@/components/PasswordForm";
import { loginHref, newPasswordPath, safeRedirect } from "@/components/auth-redirect";

export const dynamic = "force-dynamic";
export const metadata = { title: "Password" };

/** Where a password reset link lands, signed in. Also for changing a password. */
export default async function PasswordPage({ searchParams }: { searchParams: Promise<{ redirect?: string }> }) {
  // Where logging in started (say, pricing), to carry on there afterwards.
  const back = safeRedirect((await searchParams).redirect, "");
  const profile = await getProfile();
  if (!profile) redirect(loginHref(newPasswordPath(back)));

  return (
    <div className="min-h-screen">
      <AppNav plan={profile.plan} email={profile.email} billing={profile.billing} />
      <main id="main" className="container max-w-md py-10">
        <h1 className="text-3xl font-bold tracking-tight">New password</h1>
        <p className="mt-1 text-sm text-muted-foreground">For {profile.email}</p>
        <PasswordForm next={back} />
      </main>
    </div>
  );
}
