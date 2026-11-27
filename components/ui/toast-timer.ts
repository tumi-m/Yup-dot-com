/**
 * Toast timing: each toast closes after its time, but not while the pointer
 * or keyboard focus is on the stack (WCAG 2.2.1). Held toasts get their
 * remaining time back when let go, with at least a second to read.
 */
export const TOAST_MS = { error: 6000, other: 3500 } as const;
const MIN_AFTER_HOLD_MS = 1000;

export interface ToastClock {
  /** When the running countdown started; null while held. */
  startedAt: number | null;
  /** Time left when the countdown (re)started. */
  left: number;
}

export function startClock(ms: number, now: number): ToastClock {
  return { startedAt: now, left: ms };
}

/** Stops the countdown, keeping what is left. */
export function holdClock(c: ToastClock, now: number): ToastClock {
  if (c.startedAt === null) return c;
  return { startedAt: null, left: Math.max(0, c.left - (now - c.startedAt)) };
}

/** Starts it again; returns the clock and how long until the toast closes. */
export function releaseClock(c: ToastClock, now: number): { clock: ToastClock; ms: number } {
  if (c.startedAt !== null) return { clock: c, ms: Math.max(0, c.left - (now - c.startedAt)) };
  const ms = Math.max(MIN_AFTER_HOLD_MS, c.left);
  return { clock: { startedAt: now, left: ms }, ms };
}

interface Said {
  id: number;
  tone: "success" | "error" | "info";
}

/**
 * What the live regions say: only toasts newer than the last one said, the
 * newest of each kind. Null when nothing new arrived (a toast was dismissed),
 * so an older toast is never read a second time.
 */
export function toastsToSay<T extends Said>(toasts: T[], lastSaid: number): { polite?: T; urgent?: T; last: number } | null {
  const fresh = toasts.filter((t) => t.id > lastSaid);
  if (!fresh.length) return null;
  const newest = (error: boolean) => [...fresh].reverse().find((t) => (t.tone === "error") === error);
  return { polite: newest(false), urgent: newest(true), last: Math.max(...fresh.map((t) => t.id)) };
}
