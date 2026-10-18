import { redirect } from "next/navigation";
import { getProfile } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { PasswordForm } from "@/components/PasswordForm";
import { loginHref, NEW_PASSWORD_PATH } from "@/components/auth-redirect";

export const dynamic = "force-dynamic";
export const metadata = { title: "Password" };

/** Where a password reset link lands, signed in. Also for changing a password. */
export default async function PasswordPage() {
  const profile = await getProfile();
  if (!profile) redirect(loginHref(NEW_PASSWORD_PATH));

  return (
    <div className="min-h-screen">
      <AppNav plan={profile.plan} email={profile.email} />
      <main id="main" className="container max-w-md py-10">
        <h1 className="text-3xl font-bold tracking-tight">New password</h1>
        <p className="mt-1 text-sm text-muted-foreground">For {profile.email}</p>
        <PasswordForm />
      </main>
    </div>
  );
}
