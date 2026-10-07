"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DUR, EASE_OUT } from "@/components/motion/primitives";

/**
 * Cycles through `words` in place, easing its width so a centred headline
 * re-centres smoothly. Stops after a few rounds (and never starts with
 * reduced motion), landing back on the first word.
 */
export function RotatingWord({
  words,
  className,
  interval = 2400,
  rounds = 3,
}: {
  words: string[];
  className?: string;
  interval?: number;
  rounds?: number;
}) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const [widths, setWidths] = useState<number[]>([]);
  const measure = useRef<(HTMLSpanElement | null)[]>([]);
  const last = words.length * rounds;

  useLayoutEffect(() => {
    const read = () => setWidths(measure.current.map((el) => el ? el.offsetWidth + 2 : 0));
    read();
    const ro = new ResizeObserver(read);
    measure.current.forEach((el) => el && ro.observe(el));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words.join("|")]);

  useEffect(() => {
    if (reduce || step >= last) return;
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? interval + 1200 : interval);
    return () => clearTimeout(t);
  }, [reduce, step, last, interval]);

  const index = step % words.length;
  const width = widths[index];

  return (
    <span className="relative inline-block align-bottom" aria-hidden>
      {/* Measuring copies */}
      <span className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap">
        {words.map((w, i) => (
          <span
            key={w}
            ref={(el) => {
              measure.current[i] = el;
            }}
            className={`absolute left-0 top-0 !animate-none ${className ?? ""}`}
          >
            {w}
          </span>
        ))}
      </span>
      <motion.span
        className="relative inline-grid overflow-hidden whitespace-nowrap pb-[0.12em] text-left align-bottom"
        initial={false}
        animate={width ? { width } : undefined}
        transition={reduce ? { duration: 0 } : { duration: DUR.slow, ease: EASE_OUT }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={words[index]}
            className={`col-start-1 row-start-1 ${className ?? ""}`}
            initial={{ y: "80%", opacity: 0 }}
            animate={{ y: "0%", opacity: 1 }}
            exit={{ y: "-80%", opacity: 0 }}
            transition={{ duration: DUR.slow, ease: EASE_OUT }}
          >
            {words[index]}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </span>
  );
}
