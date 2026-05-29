import Link from "next/link";
import {
  ArrowRight,
  PenLine,
  Highlighter,
  Layers,
  Signature,
  Shield,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarketingNav } from "@/components/MarketingNav";
import { createClient } from "@/lib/supabase/server";

const FEATURES = [
  {
    icon: PenLine,
    title: "Annotate & add text",
    body: "Drop text anywhere, add notes, and mark up documents with a click.",
  },
  {
    icon: Highlighter,
    title: "Highlight & draw",
    body: "Freehand drawing and colour highlights to make the important parts pop.",
  },
  {
    icon: Layers,
    title: "Page operations",
    body: "Merge, split, reorder, rotate, and delete pages — all in the browser.",
  },
  {
    icon: Signature,
    title: "Fill & sign",
    body: "Fill out forms and drop a signature without printing a single page.",
  },
  {
    icon: Zap,
    title: "Instant exports",
    body: "Everything is baked into a clean, standards-compliant PDF on export.",
  },
  {
    icon: Shield,
    title: "Private by default",
    body: "Your documents are yours. Stored securely and never shared.",
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
        <section className="container flex flex-col items-center py-24 text-center">
          <span className="mb-6 inline-flex items-center rounded-full border border-border bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground animate-fade-in">
            ✨ The PDF editor that just works
          </span>
          <h1 className="max-w-3xl text-balance text-5xl font-bold tracking-tight sm:text-6xl animate-fade-in">
            Edit any PDF.{" "}
            <span className="text-primary">Right in your browser.</span>
          </h1>
          <p className="mt-6 max-w-xl text-balance text-lg text-muted-foreground animate-fade-in">
            Annotate, sign, merge, and reorganise documents in seconds. No
            downloads, no clunky desktop apps — just Yup.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row animate-fade-in">
            <Button asChild size="lg">
              <Link href={user ? "/dashboard" : "/signup"}>
                {user ? "Open dashboard" : "Start editing free"}
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/pricing">View pricing</Link>
            </Button>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="border-t border-border bg-secondary/40 py-24">
          <div className="container">
            <h2 className="text-center text-3xl font-bold tracking-tight">
              Everything you need, nothing you don&apos;t
            </h2>
            <p className="mx-auto mt-3 max-w-lg text-center text-muted-foreground">
              A complete PDF toolkit that lives in the cloud.
            </p>
            <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
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
        <section className="container py-24 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Ready to ditch the desktop app?
          </h2>
          <p className="mx-auto mt-3 max-w-md text-muted-foreground">
            Sign up free. Edit your first PDF in under a minute.
          </p>
          <Button asChild size="lg" className="mt-8">
            <Link href={user ? "/dashboard" : "/signup"}>
              Get started <ArrowRight />
            </Link>
          </Button>
        </section>
      </main>

      <footer className="border-t border-border py-8">
        <div className="container flex flex-col items-center justify-between gap-4 text-sm text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} Yup. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link href="/login" className="hover:text-foreground">Log in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
