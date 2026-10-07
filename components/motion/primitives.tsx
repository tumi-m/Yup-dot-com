"use client";

import {
  MotionConfig,
  animate,
  motion,
  useInView,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { EASE, STAGGER, staggerDelay } from "./tokens";

export * from "./tokens";

/** Honours the OS "reduce motion" setting for every motion component below. */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/**
 * Pauses the CSS loops inside an element while it is offscreen. Returns a ref
 * for that element; the pause itself is a `data-paused` rule in globals.css,
 * so no re-render happens.
 */
export function useAmbient<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        el.dataset.paused = entry.isIntersecting ? "false" : "true";
      },
      { rootMargin: "120px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

// One observer for every Reveal on the page.
let revealObserver: IntersectionObserver | null = null;
const revealCallbacks = new WeakMap<Element, (order: number) => void>();

function observeReveal(el: Element, onShow: (order: number) => void) {
  revealObserver ??= new IntersectionObserver(
    (entries) => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        revealCallbacks.get(entry.target)?.(order++);
        revealCallbacks.delete(entry.target);
        revealObserver?.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -40px 0px" }
  );
  revealCallbacks.set(el, onShow);
  revealObserver.observe(el);
  return () => {
    revealCallbacks.delete(el);
    revealObserver?.unobserve(el);
  };
}

/**
 * Fades and lifts content in, once, when it scrolls into view. Server HTML is
 * never hidden: only content still below the fold at hydration is held back,
 * so nothing is invisible without JS or before hydration. Items that enter
 * together stagger.
 */
export function Reveal({
  children,
  className,
  as = "div",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "div" | "section" | "li" | "span";
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.dataset.reveal = "pending";
    return observeReveal(el, (order) => {
      el.style.setProperty("--reveal-delay", `${staggerDelay(order)}s`);
      el.dataset.reveal = "shown";
    });
  }, []);
  const Tag = as as "div";
  return (
    <Tag ref={ref as React.RefObject<HTMLDivElement>} className={className}>
      {children}
    </Tag>
  );
}

/**
 * Headline that rises in word by word. CSS keyframes, so the server-rendered
 * text paints before hydration and stays put with reduced motion.
 */
export function WordReveal({
  text,
  className,
  delay = 0,
}: {
  text: string;
  className?: string;
  delay?: number;
}) {
  const words = text.split(" ");
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      {words.map((word, i) => (
        <span key={i} className="inline-block overflow-hidden pb-[0.12em] align-bottom" aria-hidden>
          <span
            className="inline-block motion-safe:animate-rise-word"
            style={{ animationDelay: `${delay + i * STAGGER * 1.5}s` }}
          >
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * A card with a soft light that follows the cursor. Lifts on hover, and on
 * keyboard focus of the link that wraps it.
 */
export function SpotlightCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const x = useMotionValue(-200);
  const y = useMotionValue(-200);
  const background = useMotionTemplate`radial-gradient(260px circle at ${x}px ${y}px, hsl(var(--primary) / 0.12), transparent 70%)`;

  return (
    <div
      className={cn(
        "group relative overflow-hidden transition-[transform,border-color,box-shadow] duration-300 ease-out hover:-translate-y-[3px] hover:shadow-lg hover:shadow-primary/5 group-focus-visible/link:-translate-y-[3px] motion-reduce:transform-none",
        className
      )}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        x.set(e.clientX - rect.left);
        y.set(e.clientY - rect.top);
      }}
      onPointerLeave={() => {
        x.set(-200);
        y.set(-200);
      }}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background }}
      />
      {children}
    </div>
  );
}

/** Counts up to a number when it scrolls into view. */
export function CountUp({
  to,
  suffix = "",
  duration = 1.4,
  className,
}: {
  to: number;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setValue(to);
      return;
    }
    const controls = animate(0, to, {
      duration,
      ease: EASE,
      onUpdate: (v) => setValue(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, to, duration, reduce]);

  return (
    <span ref={ref} className={className}>
      {value.toLocaleString()}
      {suffix}
    </span>
  );
}

/** Pops a ring of sparkles outward — used for success moments. */
export function SparkleBurst({ count = 14 }: { count?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        const distance = 70 + (i % 3) * 22;
        return (
          <motion.span
            key={i}
            className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
            style={{
              background: i % 3 === 0 ? "#fbbf24" : i % 3 === 1 ? "hsl(var(--primary))" : "#f472b6",
            }}
            initial={{ x: 0, y: 0, scale: 0, opacity: 1 }}
            animate={{
              x: Math.cos(angle) * distance,
              y: Math.sin(angle) * distance,
              scale: [0, 1.4, 0],
              opacity: [1, 1, 0],
            }}
            transition={{ duration: 0.9, ease: EASE, delay: 0.1 + (i % 4) * 0.03 }}
          />
        );
      })}
    </div>
  );
}
