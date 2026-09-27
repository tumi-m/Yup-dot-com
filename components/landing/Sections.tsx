"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Braces,
  Combine,
  Download,
  Lock,
  MousePointerClick,
  ScanText,
  ShieldCheck,
  Signature,
  Sparkles,
  UploadCloud,
  Wand2,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { WizardHat } from "@/components/WizardLogo";
import { TOOLS } from "@/lib/tools";
import { OCR_LANGUAGES } from "@/lib/pdf/ocr-languages";
import {
  CountUp,
  EASE,
  Reveal,
  SpotlightCard,
  Stagger,
  StaggerItem,
  WordReveal,
} from "@/components/motion/primitives";
import { Aurora, HeroScene, Starfield } from "./HeroScene";
import { HeroDropzone } from "./HeroDropzone";

export function Hero({ isAuthed }: { isAuthed: boolean }) {
  return (
    <section className="relative overflow-hidden">
      <Aurora />
      <Starfield />
      <div className="container relative grid grid-cols-1 items-center gap-12 py-16 lg:grid-cols-[1.05fr_1fr] lg:py-24">
        <div className="min-w-0 text-center lg:text-left">
          <motion.span
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-background/70 px-4 py-1.5 text-xs font-medium text-accent-foreground shadow-sm backdrop-blur"
          >
            <WizardHat className="h-3.5 w-3.5 text-primary" />
            Free PDF editor · no sign-up · no watermark
          </motion.span>

          <h1 className="text-balance text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
            <WordReveal text="Cast spells on" />{" "}
            <motion.span
              initial={{ opacity: 0, scale: 0.8, filter: "blur(10px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              transition={{ duration: 0.9, ease: EASE, delay: 0.35 }}
              className="inline-block bg-gradient-to-r from-violet-600 via-fuchsia-500 to-amber-400 bg-[length:200%_auto] bg-clip-text text-transparent motion-safe:animate-shimmer"
            >
              your PDFs.
            </motion.span>
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.55 }}
            className="mx-auto mt-6 max-w-xl text-balance text-lg text-muted-foreground lg:mx-0"
          >
            Merge, compress, convert to Word and Excel, OCR scans, password-protect,
            edit, and sign — all in your browser. Fast as a spell, private by design.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.7 }}
            className="mt-9"
          >
            <HeroDropzone />
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.95, duration: 0.6 }}
            className="mt-5 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm lg:justify-start"
          >
            <Link href="/tools" className="group inline-flex items-center gap-1 font-medium text-primary">
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

/** Only facts we can stand behind — no invented user counts. */
export function Stats() {
  const items = [
    { value: TOOLS.filter((t) => t.category !== "media").length, suffix: "", label: "PDF tools" },
    { value: OCR_LANGUAGES.length, suffix: "", label: "OCR languages" },
    { value: 0, suffix: "", label: "PDFs uploaded to process them" },
    { value: 1080, suffix: "p", label: "YouTube downloads with Pro" },
  ];
  return (
    <section className="container py-16">
      <Stagger className="grid grid-cols-2 gap-6 md:grid-cols-4">
        {items.map((s) => (
          <StaggerItem key={s.label} className="rounded-2xl border border-border bg-card p-6 text-center">
            <CountUp to={s.value} suffix={s.suffix} className="text-4xl font-extrabold tracking-tight text-primary" />
            <p className="mt-1 text-sm text-muted-foreground">{s.label}</p>
          </StaggerItem>
        ))}
      </Stagger>
    </section>
  );
}

const STEPS = [
  {
    icon: UploadCloud,
    title: "Drop your file",
    body: "Drag a PDF (or a few) onto any tool. It stays on your device.",
  },
  {
    icon: MousePointerClick,
    title: "Cast the spell",
    body: "Pick options if you like, then hit Cast. Most spells finish in a blink.",
  },
  {
    icon: Download,
    title: "Take the result",
    body: "Download instantly — or save it to your library with a free account.",
  },
];

export function HowItWorks() {
  const reduce = useReducedMotion();
  return (
    <section className="relative py-24">
      <div className="container">
        <Reveal className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">How it works</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Three steps. Zero friction.</h2>
        </Reveal>

        <div className="relative mt-16 grid gap-8 md:grid-cols-3">
          {/* connecting beam that draws itself as it scrolls in */}
          <svg aria-hidden className="absolute left-[16%] right-[16%] top-8 hidden h-2 w-[68%] md:block" viewBox="0 0 100 2" preserveAspectRatio="none">
            <motion.line
              x1="0" y1="1" x2="100" y2="1"
              stroke="hsl(var(--primary))"
              strokeWidth="2"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0 }}
              whileInView={{ pathLength: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 1.4, ease: EASE, delay: 0.3 }}
            />
          </svg>

          {STEPS.map((step, i) => (
            <Reveal key={step.title} delay={i * 0.15} className="relative text-center">
              <motion.div
                className="relative mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-xl shadow-primary/30"
                animate={reduce ? undefined : { y: [0, -6, 0] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut", delay: i * 0.4 }}
              >
                <step.icon className="h-7 w-7" />
                <span className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-xs font-bold text-amber-950">
                  {i + 1}
                </span>
              </motion.div>
              <h3 className="mt-5 text-lg font-semibold">{step.title}</h3>
              <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted-foreground">{step.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

const HIGHLIGHTS = [
  { icon: Combine, title: "One toolkit for everything", body: "Merge, split, compress, convert, rotate, watermark, protect, edit, and sign — all in one place." },
  { icon: Lock, title: "Private by design", body: "Tools run entirely in your browser. Your files never touch a server." },
  { icon: ScanText, title: "OCR for scans", body: "Turn scanned pages into searchable, selectable text — recognised on your own device." },
  { icon: Braces, title: "Layout-aware parsing", body: "Word, Excel, Markdown, and RAG chunks with headings, tables, and reading order preserved." },
  { icon: Signature, title: "Fill & sign", body: "Fill existing forms, add your own fields, and drop a signature anywhere." },
  { icon: Wand2, title: "A real editor", body: "Whiteout, shapes, arrows, notes, links, and undo — then rearrange pages at will." },
];

export function Highlights() {
  return (
    <section id="features" className="border-t border-border bg-secondary/30 py-24">
      <div className="container">
        <Reveal className="mx-auto max-w-xl text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">Why PDF Wizard</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Powerful magic. No hocus-pocus.</h2>
        </Reveal>
        <Stagger className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {HIGHLIGHTS.map((f) => (
            <StaggerItem key={f.title}>
              <SpotlightCard className="h-full rounded-2xl border border-border bg-card p-6">
                <div className="relative">
                  <motion.div
                    whileHover={{ rotate: [0, -12, 12, 0] }}
                    transition={{ duration: 0.5 }}
                    className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary"
                  >
                    <f.icon className="h-5 w-5" />
                  </motion.div>
                  <h3 className="mt-4 font-semibold">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
                </div>
              </SpotlightCard>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
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
          <p className="mx-auto mt-4 max-w-md text-lg text-muted-foreground">
            No account, no credit card, no installs — just results.
          </p>
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
