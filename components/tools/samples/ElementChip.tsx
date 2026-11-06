"use client";

import { motion } from "motion/react";
import { DUR, EASE_OUT } from "@/components/motion/primitives";
import type { SampleElement } from "@/lib/samples/types";
import { cn } from "@/lib/utils";

export const ELEMENT_LABEL: Record<SampleElement, string> = {
  "hook-riff": "Hook / riff",
  "vocals-lyrics": "Vocals / lyrics",
  drums: "Drums",
  bass: "Bass",
  multiple: "Multiple elements",
  "sound-effect": "Sound effect",
  interpolation: "Interpolation",
};

const TINT: Record<SampleElement, string> = {
  "hook-riff": "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200",
  "vocals-lyrics": "bg-rose-100 text-rose-900 dark:bg-rose-950/50 dark:text-rose-200",
  drums: "bg-sky-100 text-sky-900 dark:bg-sky-950/50 dark:text-sky-200",
  bass: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-200",
  multiple: "bg-secondary text-secondary-foreground",
  "sound-effect": "bg-teal-100 text-teal-900 dark:bg-teal-950/50 dark:text-teal-200",
  interpolation: "bg-violet-100 text-violet-900 dark:bg-violet-950/50 dark:text-violet-200",
};

/** What a sample takes. Fades in at `fast` once its row has landed. */
export function ElementChip({ element, delay = 0 }: { element: SampleElement; delay?: number }) {
  return (
    <motion.span
      data-testid="element-chip"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DUR.fast, ease: EASE_OUT, delay }}
      title={element === "interpolation" ? "Replayed or re-sung, not lifted from the record" : undefined}
      className={cn("inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[11px] font-semibold", TINT[element])}
    >
      {ELEMENT_LABEL[element]}
    </motion.span>
  );
}
