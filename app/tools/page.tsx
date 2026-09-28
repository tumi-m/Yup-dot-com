import type { Metadata } from "next";
import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ToolGrid } from "@/components/ToolGrid";
import { Starfield } from "@/components/landing/HeroScene";
import { WordReveal } from "@/components/motion/primitives";
import { getCurrentUser } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "All PDF Tools — PDF Wizard",
  description:
    "Every PDF spell in one place — merge, split, compress, convert, OCR, protect, edit, and sign — plus YouTube to MP4 (up to 1080p) and X (Twitter) to MP4/MP3.",
  alternates: { canonical: "/tools" },
};

export default async function ToolsPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-border bg-gradient-to-b from-primary/10 to-background">
          <Starfield />
          <div className="container relative py-16 text-center">
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              <WordReveal text="All tools" />
            </h1>
          </div>
        </section>
        <div className="container py-12">
          <ToolGrid filterable />
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
