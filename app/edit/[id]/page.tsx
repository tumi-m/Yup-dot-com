import type { Metadata } from "next";
import { PdfEditor } from "@/components/editor/PdfEditor";
import { getProfile } from "@/lib/profile";

export const metadata: Metadata = {
  title: "Edit PDF",
  robots: { index: false },
};

/**
 * The no-account editor. The document lives in this browser's IndexedDB, so
 * anyone can edit, fill, and sign without signing up — like PDFescape.
 */
export default async function LocalEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await getProfile().catch(() => null);
  return <PdfEditor source={{ kind: "local", id }} tier={profile?.plan ?? "guest"} />;
}
