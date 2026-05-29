import { redirect, notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { PdfEditor } from "@/components/editor/PdfEditor";
import type { DocumentRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function EditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await getProfile();
  if (!profile) redirect(`/login?redirect=/editor/${id}`);

  const supabase = await createClient();
  const { data: doc } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (!doc) notFound();

  return (
    <PdfEditor
      document={doc as DocumentRecord}
      plan={profile.plan}
    />
  );
}
