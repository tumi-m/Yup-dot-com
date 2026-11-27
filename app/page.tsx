import type { Metadata, ResolvingMetadata } from "next";
import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { ToolGrid } from "@/components/ToolGrid";
import { Reveal } from "@/components/motion/primitives";
import { AfterHero, FinalCta, Hero, HeroFlow } from "@/components/landing/Sections";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import type { Tier } from "@/lib/limits";
import { siteUrl } from "@/lib/site";
import { siteJsonLd } from "@/lib/structured-data";
import { JsonLd } from "@/components/JsonLd";

// The site's own title, description and image (app/layout.tsx), at its own address.
export async function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  const og = (await parent).openGraph;
  return {
    alternates: { canonical: "/" },
    openGraph: { type: "website", title: og?.title?.absolute, description: og?.description, images: og?.images, url: "/" },
  };
}

export default async function HomePage() {
  const user = await getCurrentUser();
  // The home page offers tools for a dropped file, so it needs the plan's size limit.
  const profile = user ? await getProfile().catch(() => null) : null;
  const tier: Tier = profile?.plan ?? "guest";

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main id="main" className="flex-1">
        <HeroFlow>
        <Hero isAuthed={!!user} tier={tier} />

        <AfterHero>
        <section className="border-t border-border py-16 sm:py-24">
          <div className="container">
            <Reveal className="mx-auto max-w-xl text-center">
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">All tools</h2>
            </Reveal>
            <div className="mt-10 sm:mt-14">
              <ToolGrid />
            </div>
          </div>
        </section>

        <FinalCta />
        </AfterHero>
        </HeroFlow>
      </main>
      <SiteFooter />
      <JsonLd data={siteJsonLd(siteUrl())} />
    </div>
  );
}
