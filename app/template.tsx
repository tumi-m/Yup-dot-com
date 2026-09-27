"use client";

import { motion } from "motion/react";

/**
 * Re-mounted on every navigation, so each route fades in. Kept deliberately
 * short so navigation never feels slower than it is.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
