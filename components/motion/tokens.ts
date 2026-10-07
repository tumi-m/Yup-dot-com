/**
 * The motion language. Every duration, curve and spring in the product comes
 * from here, so it moves like one system.
 *
 * Rules:
 * - Entrances: fade plus an 8–12px rise at `base`. Exits: fade only at `fast`
 *   (never longer than the entrance).
 * - Hover lifts cards 3px; press scales to 0.97; buttons don't lift.
 * - No filter or blur animations. Ambient loops only in the hero and the
 *   closing call to action, and they pause offscreen.
 * - Content that must be read first never waits for JS: entrances that run on
 *   first paint are CSS keyframes (see tailwind.config.ts).
 */
export const DUR = { tap: 0.12, fast: 0.2, base: 0.3, slow: 0.5, hero: 0.7 } as const;

/** Fast in, soft landing. For entrances. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
/** Slow start, quick finish. For exits. */
export const EASE_IN = [0.55, 0, 1, 0.45] as const;
/** Default curve. */
export const EASE = EASE_OUT;

/** UI press and hover. */
export const SPRING = { type: "spring", stiffness: 380, damping: 30 } as const;
/** Icons and success moments. */
export const SPRING_POP = { type: "spring", stiffness: 420, damping: 22 } as const;
/** Shared-layout pills and indicators. */
export const SPRING_LAYOUT = { type: "spring", stiffness: 500, damping: 40 } as const;

/** Delay between siblings in a list entrance. */
export const STAGGER = 0.04;
/** Items past this index enter together, so long lists don't trickle in. */
export const STAGGER_CAP = 12;

export function staggerDelay(index: number, step: number = STAGGER, cap: number = STAGGER_CAP): number {
  return Math.min(Math.max(index, 0), cap) * step;
}
