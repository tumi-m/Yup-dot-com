/**
 * The motion language. Every duration, curve, spring and stagger in the
 * product comes from here (tailwind.config.ts reads the same numbers for the
 * CSS side), so the whole site moves like one system.
 *
 * Personality: calm and precise for UI, playful only for the hero
 * illustration and the one success moment.
 *
 * Rules:
 * - Entrances rise 8px and fade in at `base` on EASE_OUT. Exits fade (and lift
 *   4px) at `fast` on EASE_IN: never longer than ~70% of the entrance, and they
 *   never stagger. A full swap (exit, then enter) stays under 0.4s.
 * - Press scales to 0.97 in 0.1s. Cards and tiles lift 2px on hover; buttons
 *   never lift.
 * - Animate transform and opacity only. Anything that must keep moving while
 *   the page is busy (progress, spinners) is CSS, so it runs on the compositor.
 * - Ambient loops are CSS, pause offscreen (useAmbient) and stop with reduced
 *   motion.
 * - Content that must be read first never waits: the page's largest text is
 *   never hidden behind an opacity entrance or a delay.
 */

/** Seconds. */
export const DUR = {
  /** Press feedback, hover-in. */
  tap: 0.1,
  /** Small toggles, icon swaps, chips, every exit. */
  fast: 0.15,
  /** UI entrances: panels, cards, rows, toasts, dialogs. */
  base: 0.24,
  /** The success card, large panel changes, page-level swaps. */
  slow: 0.4,
  /** Homepage first-paint choreography only. */
  hero: 0.6,
} as const;

/** Fast in, soft landing. Every entrance. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** Gentle start, quick departure. Every exit. */
export const EASE_IN = [0.4, 0, 1, 1] as const;
/** On-screen moves between two states: progress fill, height, indicators. */
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;
/** @deprecated Name the direction: EASE_OUT, EASE_IN or EASE_IN_OUT. */
export const EASE = EASE_OUT;

/** Press, hover and drag response. No overshoot. */
export const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;
/** Shared-layout pills, indicators and list reflow. */
export const SPRING_LAYOUT = { type: "spring", stiffness: 500, damping: 40 } as const;
/**
 * About 8% overshoot. Only the success badge, a file tile taking a drop and
 * the chosen-branch icon; nothing else in the UI overshoots.
 */
export const SPRING_POP = { type: "spring", stiffness: 420, damping: 22 } as const;
/** The hero illustration following the cursor: slow and soft. */
export const SPRING_TILT = { stiffness: 60, damping: 18 } as const;

/** Delay between siblings in a list entrance. */
export const STAGGER = 0.03;
/** Items past this index enter together, so a list never trickles (≤ 0.24s). */
export const STAGGER_CAP = 8;
/** Page-level first-paint beats (hero words, pricing cards). */
export const STAGGER_HERO = 0.06;

export function staggerDelay(index: number, step: number = STAGGER, cap: number = STAGGER_CAP): number {
  return Math.min(Math.max(index, 0), cap) * step;
}

/** The common entrance transition. */
export const ENTER_T = { duration: DUR.base, ease: EASE_OUT } as const;
/** The common exit transition. */
export const EXIT_T = { duration: DUR.fast, ease: EASE_IN } as const;
/** Fade and rise in. */
export const ENTER = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: ENTER_T },
} as const;
/** Fade and lift out. */
export const EXIT = { opacity: 0, y: -4, transition: EXIT_T } as const;
/** Fade out in place. */
export const FADE_EXIT = { opacity: 0, transition: EXIT_T } as const;
/** Scale in from 96%: dialogs, popovers, notices. */
export const POP_IN = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1, transition: ENTER_T },
  exit: { opacity: 0, scale: 0.98, transition: EXIT_T },
} as const;

/** One firm shake for errors: no overshoot, settles at rest. */
export const SHAKE_X = [0, -6, 6, -4, 4, 0];
export const SHAKE_T = { duration: 0.32, ease: EASE_IN_OUT, delay: 0.05 } as const;
/** Inline messages fade and slide in a little quicker than a panel. */
export const NOTICE_T = { duration: 0.2, ease: EASE_OUT } as const;

/** Determinate progress fill: one smooth glide per update. */
export const PROGRESS_T = 0.3;
/** The bar holds at 100% this long before the result replaces it. */
export const PROGRESS_HOLD_MS = 180;

/**
 * The success moment, in seconds from the card's mount. The primary action is
 * interactive by 0.45s; the upsell card waits until the moment has landed.
 */
export const SUCCESS = {
  icon: 0,
  title: 0.08,
  check: 0.12,
  stats: 0.14,
  actions: 0.2,
  list: 0.24,
  corner: 0.25,
  next: 0.28,
  upsell: 0.6,
  /** Numbers count to their final value over this long. */
  count: 0.7,
  /** The sparkle ring. */
  burst: 0.7,
} as const;
/** The card itself: transform settles at `slow`, opacity is in by `base`. */
export const SUCCESS_CARD_T = {
  duration: DUR.slow,
  ease: EASE_OUT,
  opacity: { duration: DUR.base, ease: EASE_OUT },
} as const;

/** A guest's sign-up nudge waits this long after success, and only if idle. */
export const NUDGE_DELAY_MS = 2500;

/** `cubic-bezier(...)` for CSS. */
export function cssEase(curve: readonly [number, number, number, number]): string {
  return `cubic-bezier(${curve.join(", ")})`;
}

/** Milliseconds string for CSS. */
export function cssMs(seconds: number): string {
  return `${Math.round(seconds * 1000)}ms`;
}

/**
 * A determinate fill is a full-width bar slid left, so updates move a layer
 * instead of re-laying out the track. Never quite empty, so the start shows.
 */
export function progressTranslate(value: number, direction: 1 | -1 = 1): string {
  const v = Math.min(1, Math.max(0.04, Number.isFinite(value) ? value : 0));
  return `translateX(${(direction * (v - 1) * 100).toFixed(2)}%)`;
}
