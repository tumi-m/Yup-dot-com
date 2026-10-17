"use client";

import {
  MotionConfig,
  animate,
  motion,
  useAnimate,
  useInView,
  useMotionTemplate,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import { useEffect, useRef } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EASE_OUT,
  FADE_EXIT,
  NOTICE_T,
  SHAKE_T,
  SHAKE_X,
  SPRING_POP,
  STAGGER_HERO,
  SUCCESS,
  staggerDelay,
} from "./tokens";

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
 * Headline that rises in word by word out of a mask. CSS keyframes on
 * transform only, so the server-rendered text paints (and counts as painted)
 * from the first frame, and stays put with reduced motion.
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
            className="inline-block motion-safe:animate-rise-mask"
            style={{ animationDelay: `${delay + i * STAGGER_HERO}s` }}
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
 * A card with a soft light that follows the cursor. Lifts 2px on hover (in
 * fast, out a little slower), and on keyboard focus of the link that wraps it.
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
  // Read layout once per hover, not on every pointer move.
  const rect = useRef<DOMRect | null>(null);

  return (
    <div
      className={cn(
        "group relative overflow-hidden transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-lg hover:shadow-primary/5 hover:duration-150 group-focus-visible/link:-translate-y-0.5 motion-reduce:transform-none",
        className
      )}
      onPointerEnter={(e) => {
        rect.current = e.currentTarget.getBoundingClientRect();
      }}
      onPointerMove={(e) => {
        const r = (rect.current ??= e.currentTarget.getBoundingClientRect());
        x.set(e.clientX - r.left);
        y.set(e.clientY - r.top);
      }}
      onPointerLeave={() => {
        rect.current = null;
        x.set(-200);
        y.set(-200);
      }}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-hover:duration-150"
        style={{ background }}
      />
      {children}
    </div>
  );
}

/**
 * Counts from one number to another when it scrolls into view, without
 * re-rendering React each frame. The box is sized for the wider end value, so
 * nothing beside it moves while it counts; screen readers get the final value
 * once.
 */
export function CountUp({
  to,
  from = 0,
  suffix = "",
  duration = 1.4,
  delay = 0,
  format = (n: number) => n.toLocaleString(),
  className,
}: {
  to: number;
  from?: number;
  suffix?: string;
  duration?: number;
  delay?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduce = useReducedMotion();
  const value = useMotionValue(from);
  const text = useTransform(value, (v) => `${format(Math.round(v))}${suffix}`);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      value.set(to);
      return;
    }
    const controls = animate(value, to, { duration, ease: EASE_OUT, delay });
    return () => controls.stop();
  }, [inView, reduce, to, duration, delay, value]);

  const ends = [`${format(Math.round(from))}${suffix}`, `${format(Math.round(to))}${suffix}`];
  const widest = ends[0].length > ends[1].length ? ends[0] : ends[1];
  return (
    <span ref={ref} className={cn("relative inline-block whitespace-nowrap tabular-nums", className)}>
      <span aria-hidden className="invisible">
        {widest}
      </span>
      <motion.span aria-hidden className="absolute inset-y-0 left-0">
        {text}
      </motion.span>
      <span className="sr-only">{ends[1]}</span>
    </span>
  );
}

/** A ring of sparkles bursting outward once, for the success moment. */
export function SparkleBurst({ count = 10, delay = 0.05 }: { count?: number; delay?: number }) {
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
            transition={{ duration: SUCCESS.burst, ease: EASE_OUT, delay: delay + staggerDelay(i % 4) }}
          />
        );
      })}
    </div>
  );
}

/**
 * The one success mark: an emerald disc that pops in, a check that draws
 * itself, a burst of sparkles and, optionally, a small icon for what was made.
 * With reduced motion it simply appears, finished.
 */
export function SuccessBadge({
  size = 64,
  icon: Icon,
  className,
}: {
  size?: number;
  /** A small corner badge naming the result, e.g. a film for a video. */
  icon?: LucideIcon;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <div
      className={cn("relative mx-auto flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <SparkleBurst />
      <motion.div
        initial={reduce ? false : { scale: 0.6, rotate: -12 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ ...SPRING_POP, delay: SUCCESS.icon }}
        className="flex h-full w-full items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30"
      >
        <svg
          viewBox="0 0 24 24"
          width={size / 2}
          height={size / 2}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            initial={reduce ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, ease: EASE_OUT, delay: SUCCESS.check }}
          />
        </svg>
      </motion.div>
      {Icon && (
        <motion.span
          aria-hidden
          initial={reduce ? false : { scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ ...SPRING_POP, delay: SUCCESS.corner }}
          className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-card bg-primary text-primary-foreground shadow"
        >
          <Icon className="h-3 w-3" />
        </motion.span>
      )}
    </div>
  );
}

/**
 * The one inline error: fades and slides in, shakes once, and fades out.
 * A new message (or a new `shakeKey` for the same one) shakes it again. With
 * reduced motion it only fades. Render it inside an AnimatePresence.
 */
export function InlineError({
  message,
  shakeKey,
  compact = false,
  className,
  children,
}: {
  message: React.ReactNode;
  shakeKey?: number | string;
  /** Small text without the pill, for tight spaces like the hero panel. */
  compact?: boolean;
  className?: string;
  /** Actions after the message, e.g. a link or a dismiss button. */
  children?: React.ReactNode;
}) {
  const [scope, animateScope] = useAnimate<HTMLParagraphElement>();
  const reduce = useReducedMotion();
  const mounted = useRef(false);
  const replay = typeof message === "string" ? message : null;

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!reduce && scope.current) void animateScope(scope.current, { x: SHAKE_X }, SHAKE_T);
  }, [replay, shakeKey, reduce, scope, animateScope]);

  return (
    <motion.p
      ref={scope}
      role="alert"
      data-testid="tool-error"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0, x: SHAKE_X }}
      exit={FADE_EXIT}
      transition={{ opacity: NOTICE_T, y: NOTICE_T, x: SHAKE_T }}
      className={cn(
        compact
          ? "flex items-center gap-1.5 text-xs font-medium text-destructive"
          : "flex items-start gap-2 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive",
        className
      )}
    >
      <AlertTriangle aria-hidden className={cn("shrink-0", compact ? "h-3.5 w-3.5" : "mt-0.5 h-4 w-4")} />
      <span className={cn("min-w-0", !compact && "flex-1")}>{message}</span>
      {children}
    </motion.p>
  );
}
