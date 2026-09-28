import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ToolGrid } from "@/components/ToolGrid";
import { Reveal } from "@/components/motion/primitives";
import {
  FinalCta,
  Hero,
  ToolMarquee,
} from "@/components/landing/Sections";
import { getCurrentUser } from "@/lib/supabase/server";

export default async function HomePage() {
  const user = await getCurrentUser();

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main className="flex-1">
        <Hero isAuthed={!!user} />
        <ToolMarquee />

        <section className="border-t border-border py-24">
          <div className="container">
            <Reveal className="mx-auto max-w-xl text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">All tools</h2>
            </Reveal>
            <div className="mt-14">
              <ToolGrid />
            </div>
          </div>
        </section>

        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
