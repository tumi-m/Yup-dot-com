import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { Starfield } from "@/components/landing/HeroScene";
import { WordReveal } from "@/components/motion/primitives";
import { PricingCards } from "@/components/PricingCards";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";
import { getPriceDisplay } from "@/lib/local-prices";

export const metadata = {
  title: "Pricing",
  description: "Free to start. Pro R49 a month: unlimited edits, no watermark, 1080p video, more AI.",
  alternates: { canonical: "/pricing" },
};

export const dynamic = "force-dynamic";

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ currency?: string }>;
}) {
  const [user, display] = await Promise.all([
    getCurrentUser(),
    searchParams.then((sp) => getPriceDisplay(sp.currency)),
  ]);
  const profile = user ? await getProfile() : null;

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main id="main" className="relative flex-1 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-gradient-to-b from-primary/10 to-transparent" />
        <Starfield className="h-[480px]" />
        <div className="container relative py-16 sm:py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              <WordReveal text="Simple, honest pricing" />
            </h1>
          </div>
          <div className="mt-14">
            <PricingCards isAuthed={!!user} currentPlan={profile?.plan} display={display} />
          </div>

          <section className="mx-auto mt-24 max-w-2xl">
            <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">FAQ</h2>
            <div className="space-y-3">
              {FAQ.map((f) => (
                <details key={f.q} className="group rounded-2xl border border-border bg-card transition-shadow open:shadow-md">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 font-medium [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span aria-hidden className="text-xl leading-none text-primary transition-transform duration-300 group-open:rotate-45">+</span>
                  </summary>
                  <p className="px-5 pb-4 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

const FAQ = [
  { q: "Do I need an account?", a: "No. Every tool works without one." },
  { q: "Are my files uploaded?", a: "No. PDF tools run in your browser. Signed in, the editor saves to your private library." },
  { q: "Can I cancel anytime?", a: "Yes, from the Billing page." },
];
