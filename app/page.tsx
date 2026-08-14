import Link from "next/link";
import {
  ArrowRight,
  Wand2,
  Lock,
  Zap,
  Combine,
  Minimize2,
  Signature,
  Braces,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "@/components/MarketingNav";
import { ToolGrid } from "@/components/ToolGrid";
import { TOOLS } from "@/lib/tools";
import { WizardHat } from "@/components/WizardLogo";
import { createClient } from "@/lib/supabase/server";

const HIGHLIGHTS = [
  {
    icon: Combine,
    title: "One toolkit for everything",
    body: "Merge, split, compress, convert, rotate, watermark, edit, and sign — all in one place.",
  },
  {
    icon: Lock,
    title: "Private by magic",
    body: "Most spells run entirely in your browser. Your files never touch a server.",
  },
  {
    icon: Zap,
    title: "Instant results",
    body: "No installs, no queues. Drop a file, cast a spell, download the result.",
  },
  {
    icon: Minimize2,
    title: "Smaller files",
    body: "Compress bulky PDFs down to email-friendly sizes without the fuss.",
  },
  {
    icon: Signature,
    title: "Fill & sign",
    body: "Sign documents and fill forms without printing a single page.",
  },
  {
    icon: Wand2,
    title: "A real editor",
    body: "Whiteout, shapes, arrows, sticky notes, links, and form fields — then rearrange pages at will.",
  },
  {
    icon: Braces,
    title: "Layout-aware parsing",
    body: "Extract to Markdown, CSV, or RAG chunks with headings, tables, and reading order preserved.",
  },
];

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav isAuthed={!!user} />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          {/* starry backdrop */}
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/10 via-background to-background" />
          <div className="container relative flex flex-col items-center py-24 text-center">
            <span className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-border bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground animate-fade-in">
              <WizardHat className="h-3.5 w-3.5" /> {TOOLS.length} PDF spells, zero
              downloads
            </span>
            <h1 className="max-w-3xl text-balance text-5xl font-bold tracking-tight sm:text-6xl animate-fade-in">
              Cast spells on your{" "}
              <span className="text-primary">PDFs.</span>
            </h1>
            <p className="mt-6 max-w-xl text-balance text-lg text-muted-foreground animate-fade-in">
              Merge, compress, convert, edit, and sign documents in seconds. PDF
              Wizard is the complete toolkit that works like magic — right in your
              browser.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row animate-fade-in">
              <Button asChild size="lg">
                <Link href="/tools">
                  Explore the tools <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link href={user ? "/dashboard" : "/signup"}>
                  {user ? "Open dashboard" : "Create free account"}
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Tools preview */}
        <section className="border-t border-border bg-secondary/40 py-20">
          <div className="container">
            <div className="mx-auto max-w-xl text-center">
              <h2 className="text-3xl font-bold tracking-tight">Your spellbook</h2>
              <p className="mt-3 text-muted-foreground">
                Every tool you need to tame your documents.
              </p>
            </div>
            <div className="mt-12">
              <ToolGrid compact />
            </div>
            <div className="mt-12 text-center">
              <Button asChild variant="outline" size="lg">
                <Link href="/tools">
                  See all tools <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Highlights */}
        <section id="features" className="py-24">
          <div className="container">
            <h2 className="text-center text-3xl font-bold tracking-tight">
              Why PDF Wizard
            </h2>
            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {HIGHLIGHTS.map((f) => (
                <div
                  key={f.title}
                  className="rounded-2xl border border-border bg-card p-6 transition-shadow hover:shadow-lg"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border bg-primary/5 py-24 text-center">
          <div className="container">
            <h2 className="text-3xl font-bold tracking-tight">
              Ready to work some magic?
            </h2>
            <p className="mx-auto mt-3 max-w-md text-muted-foreground">
              Start free. No credit card, no installs — just results.
            </p>
            <Button asChild size="lg" className="mt-8">
              <Link href="/tools">
                Get started <ArrowRight />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="container flex flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} PDF Wizard. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="/tools" className="hover:text-foreground">Tools</Link>
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link href="/login" className="hover:text-foreground">Log in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
