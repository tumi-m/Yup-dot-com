import type { ResolvingMetadata } from "next";
import { pageMetadata } from "@/lib/page-metadata";
import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ToolGrid } from "@/components/ToolGrid";
import { Starfield } from "@/components/landing/HeroScene";
import { WordReveal } from "@/components/motion/primitives";
import { YOUTUBE_ENABLED } from "@/lib/media";
import { getCurrentUser } from "@/lib/supabase/server";

// Its own title and description on shared links too, not the home page's.
export function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return pageMetadata(
    {
      title: "All PDF tools",
      description: `Merge, split, compress, convert, OCR, protect, edit and sign PDFs. PPTX to PDF, Google Slides downloads, and ${
        YOUTUBE_ENABLED ? "YouTube, X, TikTok and Instagram" : "X, TikTok and Instagram"
      } to MP4 or MP3.`,
      path: "/tools",
    },
    parent
  );
}

export default async function ToolsPage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main id="main" className="flex-1">
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
