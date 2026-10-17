"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { ENTER_T, EXIT_T, SHAKE_T, SHAKE_X, SPRING_LAYOUT } from "@/components/motion/tokens";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = nextId.current++;
      setToasts((t) => [...t, { id, message, tone }]);
      setTimeout(() => dismiss(id), tone === "error" ? 6000 : 3500);
    },
    [dismiss]
  );

  return { toasts, toast, dismiss };
}

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

/**
 * Toasts rise in, errors shake once, dismissed ones slide off to the right,
 * and the rest close the gap on the layout spring.
 */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 sm:bottom-6 sm:right-6">
      <AnimatePresence initial={false}>
      {toasts.map((t) => {
        const Icon = ICONS[t.tone];
        return (
          <motion.div
            key={t.id}
            layout
            role="status"
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
              onClick={() => onDismiss(t.id)}
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
  );
}
