"use client";

import Link from "next/link";
import { LayoutGroup, motion } from "motion/react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WizardHat } from "@/components/WizardLogo";
import { TOOLS } from "@/lib/tools";
import { Reveal, RESIZE_T, STAGGER_HERO, WordReveal } from "@/components/motion/primitives";
import { Aurora, HeroScene, Starfield } from "./HeroScene";
import { HeroJourney } from "./HeroJourney";
import { RotatingWord } from "./RotatingWord";

// Symmetric stops, so the one-off sweep never shows a seam and the resting
// position (0%) reads violet → fuchsia → amber. Deep stops keep every part
// of the word at 3.5:1 or more on the lavender hero.
const GRADIENT_WORD =
  "bg-[linear-gradient(90deg,#7c3aed,#c026d3,#b45309,#c026d3,#7c3aed)] bg-[length:200%_100%] bg-clip-text text-transparent motion-safe:animate-shimmer";

const LINE_1 = "Cast spells on";

const FOLLOW_T = { layout: RESIZE_T } as const;

/**
 * Groups the hero with what comes after it on the page, so when the journey
 * panel resizes, the content below glides with it (transform only) instead of
 * jumping or re-laying out every frame.
 */
export function HeroFlow({ children }: { children: React.ReactNode }) {
  return <LayoutGroup>{children}</LayoutGroup>;
}

/** Content below the hero: follows the journey's resize. */
export function AfterHero({ children }: { children: React.ReactNode }) {
  return (
    <motion.div layout="position" transition={FOLLOW_T}>
      {children}
    </motion.div>
  );
}

export function Hero({ isAuthed }: { isAuthed: boolean }) {
  return (
    <section className="relative overflow-hidden">
      <LayoutGroup>
      {/* The sky stretches with the section as the journey resizes, so the
          stars and the low glow glide rather than jump. */}
      <motion.div layout transition={FOLLOW_T} aria-hidden className="pointer-events-none absolute inset-0">
        <Aurora />
        <Starfield />
      </motion.div>
      {/* items-start: the headline stays put while the journey changes height. */}
      <div className="container relative grid grid-cols-1 items-start gap-12 py-16 short:py-6 lg:grid-cols-[1.05fr_1fr] lg:py-24">
        <div className="min-w-0 text-center lg:pt-4 lg:text-left">
          <h1 className="text-balance text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl short:!text-4xl">
            <WordReveal text={LINE_1} />{" "}
            <span className="sr-only">your PDFs, slides and videos.</span>
            {/* The page's largest text: painted from the first frame and only
                moved (out of a mask), never faded in. It rises after the words
                above it, so the headline reads in order. */}
            <span aria-hidden className="block overflow-hidden pb-[0.12em]">
              <span
                className="block motion-safe:animate-rise-mask"
                style={{ animationDelay: `${LINE_1.split(" ").length * STAGGER_HERO}s` }}
              >
                <RotatingWord words={["your PDFs.", "your slides.", "your videos."]} className={GRADIENT_WORD} />
              </span>
            </span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-balance text-lg text-foreground/75 short:mt-3 lg:mx-0">
            Edit and convert PDFs and slides. Save videos as MP4 or MP3.
          </p>

          <div className="mt-9 short:mt-5">
            <HeroJourney />
          </div>

          {/* The links under the journey glide with it as it resizes. */}
          <motion.div
            layout="position"
            transition={FOLLOW_T}
            className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm lg:justify-start"
          >
            <Link
              href="/tools"
              className="group inline-flex min-h-11 items-center gap-1 rounded-lg font-medium text-violet-700"
            >
              <Sparkles className="h-4 w-4" /> Browse all {TOOLS.length} tools
              <ArrowRight className="h-4 w-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5 group-hover:duration-150" />
            </Link>
            {isAuthed && (
              <Link
                href="/dashboard"
                className="inline-flex min-h-11 items-center rounded-lg font-medium text-muted-foreground hover:text-foreground"
              >
                Open your library
              </Link>
            )}
          </motion.div>
        </div>

        {/* Below the journey on phones, so it follows the resize too. */}
        <motion.div layout="position" transition={FOLLOW_T} className="min-w-0">
          <HeroScene />
        </motion.div>
      </div>
      </LayoutGroup>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-border bg-gradient-to-b from-primary/10 to-background py-28 text-center">
      <Starfield />
      <div className="container relative">
        <Reveal>
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-2xl shadow-primary/40 transition-transform duration-200 ease-out hover:-rotate-6 hover:scale-105 hover:duration-150 motion-reduce:transform-none">
            <WizardHat className="h-8 w-8" />
          </div>
          <h2 className="text-balance text-4xl font-extrabold tracking-tight sm:text-5xl">
            Ready to work some magic?
          </h2>
          <Button
            asChild
            size="lg"
            className="mt-9 h-12 px-8 text-base shadow-xl shadow-primary/30"
          >
            <a
              href="#start"
              onClick={(e) => {
                const start = document.getElementById("start");
                if (!start) return;
                e.preventDefault();
                const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                start.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
                start.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
              }}
            >
              Get started <ArrowRight />
            </a>
          </Button>
        </Reveal>
      </div>
    </section>
  );
}
