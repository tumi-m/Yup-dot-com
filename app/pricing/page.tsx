import { Suspense } from "react";
import { MarketingNav } from "@/components/MarketingNav";
import { SiteFooter } from "@/components/SiteFooter";
import { Starfield } from "@/components/landing/HeroScene";
import { WordReveal } from "@/components/motion/primitives";
import { PricingCards } from "@/components/PricingCards";
import { getCurrentUser } from "@/lib/supabase/server";
import { getProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const user = await getCurrentUser();
  const profile = user ? await getProfile() : null;

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />
      <main className="relative flex-1 overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-gradient-to-b from-primary/10 to-transparent" />
        <Starfield className="h-[480px]" />
        <div className="container relative py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
              <WordReveal text="Simple, honest pricing" />
            </h1>
            <p className="mt-4 text-muted-foreground">
              Every browser tool is free, forever. Upgrade for the cloud library,
              unlimited documents, and watermark-free editor exports.
            </p>
          </div>
          <div className="mt-16">
            <Suspense>
              <PricingCards isAuthed={!!user} currentPlan={profile?.plan} />
            </Suspense>
          </div>

          <section className="mx-auto mt-24 max-w-2xl">
            <h2 className="mb-6 text-center text-2xl font-bold tracking-tight">Questions, answered</h2>
            <div className="space-y-3">
              {FAQ.map((f) => (
                <details key={f.q} className="group rounded-2xl border border-border bg-card px-5 py-4 open:shadow-md">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                    {f.q}
                    <span aria-hidden className="text-xl leading-none text-primary transition-transform duration-300 group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
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
  {
    q: "Are the tools really free?",
    a: "Yes. Merge, split, compress, convert, OCR, protect, and the rest run in your browser with no account and no watermark. Plans only add cloud features.",
  },
  {
    q: "Do my files get uploaded?",
    a: "Not by the tools — they process files on your device. Files only reach our servers if you save them to your cloud library. The AI assistant sends the document's extracted text to answer your questions.",
  },
  {
    q: "What does the Free plan's watermark apply to?",
    a: "Only documents exported from the cloud editor. Upgrading to Pro removes it.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Manage or cancel your subscription from the Billing page at any time — no emails, no calls.",
  },
];
