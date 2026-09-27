import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ToolGrid } from "@/components/ToolGrid";
import { Reveal } from "@/components/motion/primitives";
import {
  FinalCta,
  Hero,
  Highlights,
  HowItWorks,
  Stats,
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
        <Stats />
        <HowItWorks />

        <section className="border-t border-border py-24">
          <div className="container">
            <Reveal className="mx-auto max-w-xl text-center">
              <p className="text-sm font-semibold uppercase tracking-widest text-primary">The spellbook</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                Every tool you need to tame your documents
              </h2>
            </Reveal>
            <div className="mt-14">
              <ToolGrid />
            </div>
          </div>
        </section>

        <Highlights />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
