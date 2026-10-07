"use client";

import { useEffect, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion/react";
import {
  Combine,
  Minimize2,
  Lock,
  ScanText,
  FileText,
  Signature,
  Scissors,
  Sheet,
  Sparkles,
} from "lucide-react";
import { DUR, EASE_IN, EASE_OUT, SPRING_LAYOUT, useAmbient } from "@/components/motion/primitives";

/** Deterministic PRNG so server and client render identical particles. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const rand = seeded(42);
const STARS = Array.from({ length: 24 }, () => ({
  left: rand() * 100,
  top: rand() * 100,
  size: 1.2 + rand() * 2.2,
  delay: rand() * 4,
  duration: 2.5 + rand() * 3.5,
}));

const ORBIT = [
  { icon: Combine, tint: "#8b5cf6" },
  { icon: Minimize2, tint: "#10b981" },
  { icon: Lock, tint: "#ef4444" },
  { icon: ScanText, tint: "#6366f1" },
  { icon: FileText, tint: "#3b82f6" },
  { icon: Signature, tint: "#06b6d4" },
  { icon: Scissors, tint: "#d946ef" },
  { icon: Sheet, tint: "#22c55e" },
];
const ORBIT_START = Math.PI / 8;

/**
 * The ring of tool icons. Drawn twice, each copy clipped to one half, so the
 * near half passes in front of the hat and the far half behind it.
 */
function Orbit({ half }: { half: "front" | "back" }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0 hidden md:block"
      style={{ clipPath: half === "front" ? "inset(50% -20% -20% -20%)" : "inset(-20% -20% 50% -20%)" }}
    >
      <div className="absolute inset-0 motion-safe:animate-spin-slow">
        {ORBIT.map(({ icon: Icon, tint }, i) => {
          const angle = ORBIT_START + (i / ORBIT.length) * Math.PI * 2;
          const r = 44; // % of container
          return (
            <div
              key={i}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${50 + Math.cos(angle) * r}%`, top: `${50 + Math.sin(angle) * r * 0.42}%` }}
            >
              <div className="motion-safe:animate-spin-slow-reverse">
                <div
                  className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/70 bg-background/95 shadow-lg motion-safe:animate-pop"
                  style={{ color: tint, animationDelay: `${0.3 + i * 0.05}s` }}
                >
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Twinkling background stars. CSS opacity only; paused offscreen. */
export function Starfield({ className = "" }: { className?: string }) {
  const ref = useAmbient<HTMLDivElement>();
  return (
    <div ref={ref} aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {STARS.map((s, i) => (
        <span
          key={i}
          className="absolute rounded-full bg-primary/60 motion-safe:animate-twinkle"
          style={{
            left: `${s.left}%`,
            top: `${s.top}%`,
            width: s.size,
            height: s.size,
            animationDelay: `${s.delay}s`,
            animationDuration: `${s.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Slow-drifting colour blobs. Soft radial gradients rather than blur filters,
 * so moving them costs a composite, not a re-blur.
 */
export function Aurora() {
  const ref = useAmbient<HTMLDivElement>();
  return (
    <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-56 -top-56 h-[760px] w-[760px] rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.28),transparent)] motion-safe:animate-aurora-1" />
      <div className="absolute -right-48 -top-6 h-[680px] w-[680px] rounded-full bg-[radial-gradient(closest-side,rgb(217_70_239/0.22),transparent)] motion-safe:animate-aurora-2" />
      <div className="absolute bottom-[-280px] left-1/3 h-[620px] w-[620px] rounded-full bg-[radial-gradient(closest-side,rgb(251_191_36/0.18),transparent)] motion-safe:animate-aurora-3" />
    </div>
  );
}

/** The large hat illustration. */
export function WizardHatArt({ className = "h-full w-full" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden>
      <defs>
        <linearGradient id="hat" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="0.55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#4c1d95" />
        </linearGradient>
        <linearGradient id="brim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6d28d9" />
          <stop offset="1" stopColor="#3b0764" />
        </linearGradient>
        <radialGradient id="glow">
          <stop offset="0" stopColor="#fde68a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fde68a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="160" rx="84" ry="18" fill="url(#brim)" />
      {/* cone with a jaunty bent tip */}
      <path
        d="M52 158 C 70 110, 84 70, 96 40 C 102 26, 112 18, 130 22 C 120 26, 114 34, 112 46 C 118 84, 132 120, 148 158 Z"
        fill="url(#hat)"
      />
      <path d="M58 146 C 86 152, 116 152, 144 146 L 148 158 C 116 164, 84 164, 52 158 Z" fill="#fbbf24" opacity="0.9" />
      <circle cx="104" cy="96" r="26" fill="url(#glow)" />
      <path d="M104 80l5 11 12 1.4-9 8.2 2.6 11.8-10.6-6.2-10.6 6.2 2.6-11.8-9-8.2 12-1.4z" fill="#fde047" />
      <circle cx="82" cy="126" r="3" fill="#fde68a" />
      <circle cx="126" cy="112" r="2.2" fill="#fde68a" />
      <circle cx="92" cy="70" r="1.8" fill="#fde68a" />
    </svg>
  );
}

/** A soft static shadow under the hat; replaces a per-frame drop-shadow filter. */
export function HatShadow({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute bg-[radial-gradient(closest-side,rgb(124_58_237/0.35),transparent)] ${className}`}
    />
  );
}

const DEMOS = [
  { from: "annual-report.pdf", fromMeta: "12.4 MB", to: "annual-report.pdf", toMeta: "2.1 MB · 83% smaller", spell: "Compress" },
  { from: "scanned-invoice.pdf", fromMeta: "image only · no text", to: "scanned-invoice.pdf", toMeta: "searchable · 214 words", spell: "OCR" },
  { from: "3 files", fromMeta: "contract · addendum · terms", to: "agreement.pdf", toMeta: "24 pages", spell: "Merge" },
  { from: "financials.pdf", fromMeta: "4 tables", to: "financials.xlsx", toMeta: "4 sheets · numbers you can sum", spell: "PDF → Excel" },
  { from: "offer-letter.pdf", fromMeta: "unsigned", to: "offer-letter.pdf", toMeta: "signed · fields filled", spell: "Fill & Sign" },
];

/**
 * Cycles through real before → after transformations once, then rests on the
 * first. Hover, focus or picking an example stops it.
 */
function SpellDemo() {
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce || held || stopped || step >= DEMOS.length) return;
    const id = setTimeout(() => {
      setStep((s) => s + 1);
      setIndex((i) => (i + 1) % DEMOS.length);
    }, 3800);
    return () => clearTimeout(id);
  }, [reduce, held, stopped, step]);

  const demo = DEMOS[index];

  return (
    <div
      className="relative w-full max-w-sm rounded-2xl border border-white/60 bg-background/95 p-4 shadow-2xl shadow-primary/15"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={index}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN } }}
          transition={{ duration: DUR.base, ease: EASE_OUT }}
          className="flex items-center gap-3"
        >
          <div className="min-w-0 flex-1 rounded-xl bg-secondary px-3 py-2 text-left">
            <p className="text-xs font-semibold [overflow-wrap:anywhere]">{demo.from}</p>
            <p className="text-[11px] text-muted-foreground">{demo.fromMeta}</p>
          </div>
          <div className="flex shrink-0 flex-col items-center gap-0.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground motion-safe:animate-pop [animation-delay:0.1s]">
              <Sparkles className="h-3.5 w-3.5" />
            </div>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-primary">{demo.spell}</span>
          </div>
          <div className="min-w-0 flex-1 rounded-xl bg-emerald-50 px-3 py-2 text-left ring-1 ring-emerald-200 motion-safe:animate-fade [animation-delay:0.2s]">
            <p className="text-xs font-semibold text-emerald-800 [overflow-wrap:anywhere]">{demo.to}</p>
            <p className="text-[11px] text-emerald-700">{demo.toMeta}</p>
          </div>
        </motion.div>
      </AnimatePresence>
      <div className="-mb-3 mt-0 flex justify-center">
        {DEMOS.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              setStopped(true);
              setIndex(i);
            }}
            aria-label={`Show example ${i + 1}`}
            aria-pressed={i === index}
            className="flex h-11 w-11 items-center justify-center rounded-full"
          >
            <span className="relative block h-1.5 w-6 overflow-hidden rounded-full bg-secondary">
              {i === index && (
                <motion.span layoutId="demo-pip" className="absolute inset-0 rounded-full bg-primary" transition={SPRING_LAYOUT} />
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The hero illustration: floating hat, orbiting tools, and a live demo card,
 * gently tilting toward the cursor. Loops are CSS and pause offscreen. Below md
 * only the hat and the demo show.
 */
export function HeroScene() {
  const reduce = useReducedMotion();
  const ambient = useAmbient<HTMLDivElement>();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 60, damping: 18 });
  const sy = useSpring(my, { stiffness: 60, damping: 18 });
  const rotateY = useTransform(sx, [-1, 1], [-10, 10]);
  const rotateX = useTransform(sy, [-1, 1], [8, -8]);
  const hatX = useTransform(sx, [-1, 1], [-14, 14]);
  const hatY = useTransform(sy, [-1, 1], [-10, 10]);

  return (
    <div
      ref={ambient}
      className="relative mx-auto flex w-full min-w-0 max-w-xl flex-col items-center"
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== "mouse") return;
        const rect = e.currentTarget.getBoundingClientRect();
        mx.set(((e.clientX - rect.left) / rect.width) * 2 - 1);
        my.set(((e.clientY - rect.top) / rect.height) * 2 - 1);
      }}
      onPointerLeave={() => {
        mx.set(0);
        my.set(0);
      }}
      style={{ perspective: 1000 }}
    >
      <motion.div style={{ rotateX, rotateY }} className="relative aspect-square w-full max-w-[220px] md:max-w-[420px]">
        {/* halo: a gradient, pulsing in opacity only */}
        <div
          aria-hidden
          className="absolute inset-[10%] rounded-full bg-[radial-gradient(closest-side,hsl(var(--primary)/0.3),transparent)] motion-safe:animate-pulse-slow"
        />

        {/* orbit ring */}
        <div
          aria-hidden
          className="absolute inset-[6%] hidden rounded-full border border-dashed border-primary/25 md:block"
          style={{ transform: "rotateX(62deg)" }}
        />

        {/* orbiting tools, back half (behind the hat) */}
        <Orbit half="back" />

        {/* the hat */}
        <div className="absolute inset-[22%] motion-safe:animate-pop [animation-delay:0.1s]">
          <HatShadow className="-bottom-[8%] left-[6%] h-[22%] w-[88%]" />
          <motion.div style={{ x: hatX, y: hatY }} className="h-full w-full">
            <div className="h-full w-full motion-safe:animate-float">
              <WizardHatArt />
            </div>
          </motion.div>
        </div>

        {/* front half of the orbit passes in front of the hat */}
        <Orbit half="front" />

        {/* floating document cards */}
        {[
          { cls: "left-[2%] top-[14%]", rot: -12, delay: 0.4, label: "report.pdf" },
          { cls: "right-[0%] bottom-[20%]", rot: 10, delay: 0.5, label: "invoice.pdf" },
        ].map((c) => (
          <div key={c.label} aria-hidden className={`absolute hidden md:block ${c.cls}`} style={{ transform: `rotate(${c.rot}deg)` }}>
            <div className="motion-safe:animate-rise" style={{ animationDelay: `${c.delay}s` }}>
              <div
                className="w-24 rounded-xl border border-white/60 bg-background/95 p-2.5 shadow-xl motion-safe:animate-bob"
                style={{ animationDelay: `${c.delay}s` }}
              >
                <div className="flex items-center gap-1 text-[9px] font-semibold text-red-600">
                  <FileText className="h-3 w-3" /> PDF
                </div>
                <div className="mt-2 space-y-1">
                  <div className="h-1 w-full rounded bg-secondary" />
                  <div className="h-1 w-4/5 rounded bg-secondary" />
                  <div className="h-1 w-3/5 rounded bg-secondary" />
                </div>
                <p className="mt-2 truncate text-[9px] text-muted-foreground">{c.label}</p>
              </div>
            </div>
          </div>
        ))}
      </motion.div>

      <div className="mt-2 w-full motion-safe:animate-rise [animation-delay:0.3s] md:-mt-6 md:px-4">
        <div className="flex justify-center">
          <SpellDemo />
        </div>
      </div>
    </div>
  );
}
