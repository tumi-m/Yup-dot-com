import type { Metadata } from "next";
import { MarketingNav } from "@/components/MarketingNav";
import { ToolGrid } from "@/components/ToolGrid";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "All PDF Tools — PDF Wizard",
  description:
    "Every PDF spell in one place: merge, split, compress, convert, rotate, watermark, add page numbers, edit, and sign. Free and private.",
  alternates: { canonical: "/tools" },
};

export default async function ToolsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main className="container flex-1 py-16">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            Every PDF spell in your spellbook
          </h1>
          <p className="mt-3 text-muted-foreground">
            A complete toolkit to merge, convert, compress, and command your PDFs.
            Everything runs in your browser.
          </p>
        </div>
        <div className="mt-14">
          <ToolGrid />
        </div>
      </main>
    </div>
  );
}
