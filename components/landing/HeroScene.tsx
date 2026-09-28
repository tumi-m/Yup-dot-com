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
  FileText as FileIcon,
  Sparkles,
  } from "lucide-react";
import { EASE } from "@/components/motion/primitives";

/** Deterministic PRNG so server and client render identical particles. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const rand = seeded(42);
const STARS = Array.from({ length: 46 }, () => ({
  left: rand() * 100,
  top: rand() * 100,
  size: 1 + rand() * 2.4,
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

/** Twinkling background stars. Pure CSS animation — cheap on every device. */
export function Starfield({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
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

/** Slow-drifting colour blobs behind the hero. */
export function Aurora() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -left-40 -top-40 h-[520px] w-[520px] rounded-full bg-violet-500/25 blur-3xl motion-safe:animate-aurora-1" />
      <div className="absolute -right-32 top-10 h-[460px] w-[460px] rounded-full bg-fuchsia-500/20 blur-3xl motion-safe:animate-aurora-2" />
      <div className="absolute bottom-[-180px] left-1/3 h-[420px] w-[420px] rounded-full bg-amber-400/15 blur-3xl motion-safe:animate-aurora-3" />
    </div>
  );
}

function WizardHatArt() {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full drop-shadow-[0_20px_40px_rgba(124,58,237,0.45)]">
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

const DEMOS = [
  { from: "annual-report.pdf", fromMeta: "12.4 MB", to: "annual-report.pdf", toMeta: "2.1 MB · 83% smaller", spell: "Compress" },
  { from: "scanned-invoice.pdf", fromMeta: "image only · no text", to: "scanned-invoice.pdf", toMeta: "searchable · 214 words", spell: "OCR" },
  { from: "3 files", fromMeta: "contract · addendum · terms", to: "agreement.pdf", toMeta: "24 pages", spell: "Merge" },
  { from: "financials.pdf", fromMeta: "4 tables", to: "financials.xlsx", toMeta: "4 sheets · numbers you can sum", spell: "PDF → Excel" },
  { from: "offer-letter.pdf", fromMeta: "unsigned", to: "offer-letter.pdf", toMeta: "signed · fields filled", spell: "Fill & Sign" },
];

/** Cycles through real before → after transformations. */
function SpellDemo() {
  const [index, setIndex] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % DEMOS.length), 3800);
    return () => clearInterval(id);
  }, [reduce]);

  const demo = DEMOS[index];

  return (
    <div className="relative w-full max-w-sm rounded-2xl border border-white/40 bg-background/80 p-4 shadow-2xl shadow-primary/15 backdrop-blur-xl dark:border-white/10">
      <AnimatePresence mode="wait">
        <motion.div
          key={index}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="flex items-center gap-3"
        >
          <div className="min-w-0 flex-1 rounded-xl bg-secondary px-3 py-2 text-left">
            <p className="truncate text-xs font-semibold">{demo.from}</p>
            <p className="truncate text-[11px] text-muted-foreground">{demo.fromMeta}</p>
          </div>
          <div className="flex shrink-0 flex-col items-center gap-0.5">
            <motion.div
              initial={{ scale: 0.6, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 18, delay: 0.15 }}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </motion.div>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-primary">{demo.spell}</span>
          </div>
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.3, duration: 0.4, ease: EASE }}
            className="min-w-0 flex-1 rounded-xl bg-emerald-50 px-3 py-2 text-left ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:ring-emerald-900"
          >
            <p className="truncate text-xs font-semibold text-emerald-800 dark:text-emerald-300">{demo.to}</p>
            <p className="truncate text-[11px] text-emerald-700/80 dark:text-emerald-400/80">{demo.toMeta}</p>
          </motion.div>
        </motion.div>
      </AnimatePresence>
      <div className="mt-3 flex justify-center gap-1.5">
        {DEMOS.map((_, i) => (
          <button
            key={i}
            onClick={() => setIndex(i)}
            aria-label={`Show example ${i + 1}`}
            className="relative h-1.5 w-6 overflow-hidden rounded-full bg-secondary"
          >
            {i === index && (
              <motion.span
                layoutId="demo-pip"
                className="absolute inset-0 rounded-full bg-primary"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The hero illustration: floating hat, orbiting tools, and a live demo card,
 * all gently tilting toward the cursor.
 */
export function HeroScene() {
  const reduce = useReducedMotion();
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
      className="relative mx-auto flex w-full min-w-0 max-w-xl flex-col items-center"
      onPointerMove={(e) => {
        if (reduce) return;
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
      <motion.div
        style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
        className="relative aspect-square w-full max-w-[420px]"
      >
        {/* halo */}
        <div aria-hidden className="absolute inset-[18%] rounded-full bg-primary/25 blur-3xl motion-safe:animate-pulse-slow" />

        {/* orbit ring */}
        <div aria-hidden className="absolute inset-[6%] rounded-full border border-dashed border-primary/25" style={{ transform: "rotateX(62deg)" }} />

        {/* orbiting tools */}
        <motion.div
          aria-hidden
          className="absolute inset-0"
          animate={reduce ? undefined : { rotate: 360 }}
          transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
        >
          {ORBIT.map(({ icon: Icon, tint }, i) => {
            const angle = (i / ORBIT.length) * Math.PI * 2;
            const r = 44; // % of container
            return (
              <motion.div
                key={i}
                className="absolute"
                style={{
                  left: `${50 + Math.cos(angle) * r}%`,
                  top: `${50 + Math.sin(angle) * r * 0.42}%`,
                  translateX: "-50%",
                  translateY: "-50%",
                }}
                animate={reduce ? undefined : { rotate: -360 }}
                transition={{ duration: 40, repeat: Infinity, ease: "linear" }}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.5 + i * 0.08, type: "spring", stiffness: 300, damping: 18 }}
                  whileHover={{ scale: 1.2 }}
                  className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/60 bg-background/90 shadow-lg backdrop-blur dark:border-white/10"
                  style={{ color: tint }}
                >
                  <Icon className="h-5 w-5" />
                </motion.div>
              </motion.div>
            );
          })}
        </motion.div>

        {/* the hat */}
        <motion.div
          style={{ x: hatX, y: hatY }}
          className="absolute inset-[22%]"
          initial={{ opacity: 0, scale: 0.6, y: 30 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: EASE, delay: 0.2 }}
        >
          <motion.div
            className="h-full w-full"
            animate={reduce ? undefined : { y: [0, -12, 0], rotate: [-2, 2, -2] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          >
            <WizardHatArt />
          </motion.div>
        </motion.div>

        {/* floating document cards */}
        {[
          { cls: "left-[2%] top-[14%]", rot: -12, delay: 0.9, label: "report.pdf" },
          { cls: "right-[0%] bottom-[20%]", rot: 10, delay: 1.1, label: "invoice.pdf" },
        ].map((c) => (
          <motion.div
            key={c.label}
            aria-hidden
            className={`absolute ${c.cls}`}
            initial={{ opacity: 0, y: 20, rotate: c.rot }}
            animate={{ opacity: 1, y: 0, rotate: c.rot }}
            transition={{ delay: c.delay, duration: 0.8, ease: EASE }}
          >
            <motion.div
              animate={reduce ? undefined : { y: [0, -8, 0] }}
              transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut", delay: c.delay }}
              className="w-24 rounded-xl border border-white/60 bg-background/95 p-2.5 shadow-xl dark:border-white/10"
            >
              <div className="flex items-center gap-1 text-[9px] font-semibold text-red-500">
                <FileIcon className="h-3 w-3" /> PDF
              </div>
              <div className="mt-2 space-y-1">
                <div className="h-1 w-full rounded bg-secondary" />
                <div className="h-1 w-4/5 rounded bg-secondary" />
                <div className="h-1 w-3/5 rounded bg-secondary" />
              </div>
              <p className="mt-2 truncate text-[9px] text-muted-foreground">{c.label}</p>
            </motion.div>
          </motion.div>
        ))}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.2, duration: 0.7, ease: EASE }}
        className="-mt-6 w-full px-4"
      >
        <div className="flex justify-center">
          <SpellDemo />
        </div>
      </motion.div>
    </div>
  );
}
