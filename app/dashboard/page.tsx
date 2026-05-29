import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { AppNav } from "@/components/AppNav";
import { DashboardClient } from "@/components/DashboardClient";
import { maxDocumentsFor } from "@/lib/plans";
import type { DocumentRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const profile = await getProfile();
  if (!profile) redirect("/login?redirect=/dashboard");

  const supabase = await createClient();
  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .order("updated_at", { ascending: false });

  return (
    <div className="min-h-screen">
      <AppNav plan={profile.plan} email={profile.email} />
      <DashboardClient
        initialDocuments={(documents as DocumentRecord[]) ?? []}
        plan={profile.plan}
        maxDocuments={maxDocumentsFor(profile.plan)}
      />
    </div>
  );
}
