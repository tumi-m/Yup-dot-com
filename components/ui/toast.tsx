"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { ENTER_T, EXIT_T, SHAKE_T, SHAKE_X, SPRING_LAYOUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";
import { TOAST_MS, holdClock, releaseClock, startClock, toastsToSay, type ToastClock } from "./toast-timer";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Countdowns live outside state: holding and letting go re-render nothing.
  const clocks = useRef(new Map<number, { clock: ToastClock; timer?: ReturnType<typeof setTimeout> }>());
  const held = useRef(false);

  const dismiss = useCallback((id: number) => {
    clearTimeout(clocks.current.get(id)?.timer);
    clocks.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = nextId.current++;
      setToasts((t) => [...t, { id, message, tone }]);
      const ms = tone === "error" ? TOAST_MS.error : TOAST_MS.other;
      if (held.current) clocks.current.set(id, { clock: { startedAt: null, left: ms } });
      else clocks.current.set(id, { clock: startClock(ms, Date.now()), timer: setTimeout(() => dismiss(id), ms) });
    },
    [dismiss]
  );

  /** Pointer or focus on the stack: every countdown waits. */
  const hold = useCallback(() => {
    if (held.current) return;
    held.current = true;
    const now = Date.now();
    for (const entry of clocks.current.values()) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.clock = holdClock(entry.clock, now);
    }
  }, []);

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    const now = Date.now();
    for (const [id, entry] of clocks.current) {
      const { clock, ms } = releaseClock(entry.clock, now);
      entry.clock = clock;
      entry.timer = setTimeout(() => dismiss(id), ms);
    }
  }, [dismiss]);

  useEffect(() => {
    const all = clocks.current;
    return () => all.forEach((e) => clearTimeout(e.timer));
  }, []);

  return { toasts, toast, dismiss, hold, release };
}

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

/**
 * Toasts rise in, errors shake once, dismissed ones slide off to the right,
 * and the rest close the gap on the layout spring. They wait while the
 * pointer or focus is on them. Screen readers hear each message from live
 * regions that are always on the page (errors assertively), since a region
 * added together with its text is often not read.
 */
export function ToastStack({
  toasts,
  onDismiss,
  onHold,
  onRelease,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  /** From useToasts: countdowns wait while the stack is pointed at or focused. */
  onHold?: () => void;
  onRelease?: () => void;
}) {
  const stack = useRef<HTMLDivElement>(null);
  const pointerIn = useRef(false);
  const focusIn = useRef(false);
  // Where focus was before it came into the stack, to go back to.
  const returnTo = useRef<HTMLElement | null>(null);
  const settle = () => (pointerIn.current || focusIn.current ? onHold?.() : onRelease?.());

  // The last toast gone: nothing is left to point at.
  useEffect(() => {
    if (toasts.length || !pointerIn.current) return;
    pointerIn.current = false;
    settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toasts.length]);

  /** Dismiss keeps focus in the stack, or hands it back to where it came from. */
  function dismissFrom(id: number, button: HTMLButtonElement) {
    const buttons = [...(stack.current?.querySelectorAll<HTMLButtonElement>("button[data-dismiss]") ?? [])];
    const next = buttons[buttons.indexOf(button) + 1] ?? buttons[buttons.indexOf(button) - 1];
    const back = returnTo.current;
    onDismiss(id);
    if (document.activeElement !== button) return;
    if (next) next.focus();
    else {
      focusIn.current = false;
      returnTo.current = null;
      if (back?.isConnected) back.focus();
      settle();
    }
  }

  // Each toast is said once, when it arrives: dismissing the newest must not
  // bring an older one back into the region and have it read again.
  const [said, setSaid] = useState<{ polite?: Toast; urgent?: Toast }>({});
  const lastSaid = useRef(0);
  useEffect(() => {
    const next = toastsToSay(toasts, lastSaid.current);
    if (!next) return;
    lastSaid.current = next.last;
    setSaid((s) => ({ polite: next.polite ?? s.polite, urgent: next.urgent ?? s.urgent }));
  }, [toasts]);
  const { polite, urgent } = said;

  return (
    <>
      <div className="sr-only" role="status">
        {polite && <span key={polite.id}>{polite.message}</span>}
      </div>
      <div className="sr-only" role="alert">
        {urgent && <span key={urgent.id}>{urgent.message}</span>}
      </div>
      <div
        ref={stack}
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 sm:bottom-6 sm:right-6"
        onPointerEnter={() => {
          pointerIn.current = true;
          settle();
        }}
        onPointerLeave={() => {
          pointerIn.current = false;
          settle();
        }}
        onFocus={(e) => {
          if (!focusIn.current) {
            const from = e.relatedTarget;
            returnTo.current = from instanceof HTMLElement && !stack.current?.contains(from) ? from : null;
          }
          focusIn.current = true;
          settle();
        }}
        onBlur={(e) => {
          if (stack.current?.contains(e.relatedTarget as Node | null)) return;
          focusIn.current = false;
          returnTo.current = null;
          settle();
        }}
      >
        <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const Icon = ICONS[t.tone];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                ...(t.tone === "error" ? { x: SHAKE_X } : {}),
                transition: { ...ENTER_T, x: SHAKE_T },
              }}
              exit={{ opacity: 0, x: 24, transition: EXIT_T }}
              transition={{ layout: SPRING_LAYOUT }}
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-xl border bg-card px-4 py-3 shadow-lg",
                t.tone === "success" && "border-emerald-500/40",
                t.tone === "error" && "border-destructive/50",
                t.tone === "info" && "border-border"
              )}
            >
              <Icon
                aria-hidden
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0",
                  t.tone === "success" && "text-emerald-600",
                  t.tone === "error" && "text-destructive",
                  t.tone === "info" && "text-primary"
                )}
              />
              <p className="flex-1 text-sm">{t.message}</p>
              <button
                type="button"
                data-dismiss
                onClick={(e) => dismissFrom(t.id, e.currentTarget)}
                className="-my-3 -mr-3 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </motion.div>
          );
        })}
        </AnimatePresence>
      </div>
    </>
  );
}
