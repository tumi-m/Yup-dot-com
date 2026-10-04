"use client";

import Link from "next/link";
import { motion } from "motion/react";
import {
  ArrowRight,
  Sparkles,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TOOLS } from "@/lib/tools";
import {
  EASE,
  Reveal,
  WordReveal,
} from "@/components/motion/primitives";
import { Aurora, HeroScene, Starfield } from "./HeroScene";
import { HeroJourney } from "./HeroJourney";
import { RotatingWord } from "./RotatingWord";

const GRADIENT_WORD =
  "bg-gradient-to-r from-violet-600 via-fuchsia-500 to-amber-400 bg-[length:200%_auto] bg-clip-text text-transparent motion-safe:animate-shimmer";

export function Hero({ isAuthed }: { isAuthed: boolean }) {
  return (
    <section className="relative overflow-hidden">
      <Aurora />
      <Starfield />
      <div className="container relative grid grid-cols-1 items-center gap-12 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
        <div className="min-w-0 text-center lg:text-left">
          <h1 className="text-balance text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
            <WordReveal text="Cast spells on" />{" "}
            <span className="sr-only">your PDFs, slides and videos.</span>
            <motion.span
              aria-hidden
              initial={{ opacity: 0, scale: 0.8, filter: "blur(10px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.35 }}
              className="block"
            >
              <RotatingWord words={["your PDFs.", "your slides.", "your videos."]} className={GRADIENT_WORD} />
            </motion.span>
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.55 }}
            className="mx-auto mt-6 max-w-xl text-balance text-lg text-foreground/75 lg:mx-0"
          >
            Edit and convert PDFs and slides. Save videos as MP4 or MP3.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.7 }}
            className="mt-9"
          >
            <HeroJourney />
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.95, duration: 0.6 }}
            className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm lg:justify-start"
          >
            <Link href="/tools" className="tap group inline-flex items-center gap-1 font-medium text-violet-700 dark:text-violet-300">
              <Sparkles className="h-4 w-4" /> Browse all {TOOLS.length} tools
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            {isAuthed && (
              <Link href="/dashboard" className="font-medium text-muted-foreground hover:text-foreground">
                Open your library
              </Link>
            )}
          </motion.div>
        </div>

        <HeroScene />
      </div>
    </section>
  );
}

/** An endless ribbon of tool names. */
export function ToolMarquee() {
  const names = TOOLS.map((t) => t.name);
  const row = [...names, ...names];
  return (
    <div className="relative overflow-hidden border-y border-border bg-secondary/40 py-4">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-background to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-background to-transparent" />
      <div className="flex w-max gap-10 whitespace-nowrap motion-safe:animate-marquee">
        {row.map((name, i) => (
          <span key={i} className="flex items-center gap-2 text-sm font-medium text-muted-foreground" aria-hidden={i >= names.length}>
            <Sparkles className="h-3.5 w-3.5 text-primary/60" /> {name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function FinalCta() {
  return (
    <section className="relative overflow-hidden border-t border-border bg-gradient-to-b from-primary/10 to-background py-28 text-center">
      <Starfield />
      <div className="container relative">
        <Reveal>
          <motion.div
            className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-2xl shadow-primary/40"
            whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          >
            <Zap className="h-8 w-8" />
          </motion.div>
          <h2 className="text-balance text-4xl font-extrabold tracking-tight sm:text-5xl">
            Ready to work some magic?
          </h2>
          <motion.div className="mt-9 inline-block" whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.97 }}>
            <Button asChild size="lg" className="h-12 px-8 text-base shadow-xl shadow-primary/30">
              <Link href="/tools">
                Get started <ArrowRight />
              </Link>
            </Button>
          </motion.div>
        </Reveal>
      </div>
    </section>
  );
}
