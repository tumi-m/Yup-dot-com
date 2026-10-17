"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { DUR, EASE_OUT, EXIT_T } from "@/components/motion/primitives";

/**
 * Cycles through `words` in place. Every word sits in the same grid cell, so
 * the box is always as wide as the longest one and nothing around it reflows
 * when the word changes. The old word leaves upward quickly while the new
 * one rises in. Stops after a couple of rounds (and never starts with reduced
 * motion), landing back on the first word.
 */
export function RotatingWord({
  words,
  className,
  interval = 2400,
  rounds = 2,
}: {
  words: string[];
  className?: string;
  interval?: number;
  rounds?: number;
}) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const last = words.length * rounds;

  useEffect(() => {
    if (reduce || step >= last) return;
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? interval + 1200 : interval);
    return () => clearTimeout(t);
  }, [reduce, step, last, interval]);

  const index = step % words.length;

  return (
    <span
      className="relative inline-grid justify-items-center overflow-hidden whitespace-nowrap pb-[0.12em] align-bottom lg:justify-items-start"
      aria-hidden
    >
      {/* Sizers: hold the width of the longest word. */}
      {words.map((w) => (
        <span key={w} className={`invisible col-start-1 row-start-1 !animate-none ${className ?? ""}`}>
          {w}
        </span>
      ))}
      <AnimatePresence initial={false}>
        <motion.span
          key={words[index]}
          className={`col-start-1 row-start-1 ${className ?? ""}`}
          initial={{ y: "60%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1, transition: { duration: DUR.slow, ease: EASE_OUT, delay: DUR.tap } }}
          exit={{ y: "-60%", opacity: 0, transition: EXIT_T }}
        >
          {words[index]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
