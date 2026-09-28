"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { Cloud, Crown, Film, Infinity as InfinityIcon, Sparkles, X, Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatLimitBytes, LIMITS, type Tier } from "@/lib/limits";
import { PLANS } from "@/lib/plans";

export type UpsellReason = "file-size" | "batch" | "ai" | "save" | "nudge" | "quality" | "downloads";

const COPY: Record<UpsellReason, { title: string; body: (tier: Tier) => string }> = {
  "file-size": {
    title: "File too large",
    body: (t) => `Free: ${formatLimitBytes(LIMITS[t].maxFileBytes)}. Pro: ${formatLimitBytes(LIMITS.pro.maxFileBytes)}.`,
  },
  batch: {
    title: "Too many files",
    body: (t) => `Free: ${LIMITS[t].maxBatchFiles} at once. Pro: ${LIMITS.pro.maxBatchFiles}.`,
  },
  ai: {
    title: "Daily AI limit reached",
    body: (t) =>
      t === "guest"
        ? `${LIMITS.free.aiAnswersPerDay} a day with a free account, ${LIMITS.pro.aiAnswersPerDay} with Pro.`
        : `${LIMITS.pro.aiAnswersPerDay} a day with Pro.`,
  },
  quality: {
    title: "1080p is a Pro feature",
    body: () => "Free downloads go up to 720p.",
  },
  downloads: {
    title: "Daily download limit reached",
    body: (t) =>
      t === "guest"
        ? `${LIMITS.free.mediaDownloadsPerDay} a day with a free account, ${LIMITS.pro.mediaDownloadsPerDay} with Pro.`
        : `${LIMITS.pro.mediaDownloadsPerDay} a day with Pro.`,
  },
  save: {
    title: "Save to the cloud",
    body: () => "Open your documents on any device.",
  },
  nudge: {
    title: "Create a free account",
    body: () => "Keep your documents in one place.",
  },
};

const MEDIA_BENEFITS = [
  { icon: Film, text: "1080p downloads" },
  { icon: InfinityIcon, text: `${LIMITS.pro.mediaDownloadsPerDay} downloads a day` },
  { icon: Sparkles, text: "Bigger files, more AI" },
];

const BENEFITS = [
  { icon: Cloud, text: "Cloud library" },
  { icon: InfinityIcon, text: "Bigger files and batches" },
  { icon: Sparkles, text: "More AI answers" },
];

/**
 * Shown only after the user has already got value, or when they reach a
 * genuine limit. Always dismissible — the free path is never blocked.
 */
export function UpgradeDialog({
  open,
  onOpenChange,
  reason,
  tier,
  returnTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: UpsellReason;
  tier: Tier;
  returnTo?: string;
}) {
  const copy = COPY[reason];
  const guest = tier === "guest";
  // Guests are first offered the free account; account holders see Pro.
  const offerFreeAccount = guest && !["file-size", "batch", "quality"].includes(reason);
  const signup = `/signup${returnTo ? `?redirect=${encodeURIComponent(returnTo)}` : ""}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden p-0">
        <div className="relative bg-gradient-to-br from-violet-600 via-fuchsia-600 to-amber-500 px-6 pb-8 pt-7 text-white">
          <motion.div
            initial={{ scale: 0, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 15 }}
            className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20 backdrop-blur"
          >
            {offerFreeAccount ? <Sparkles className="h-6 w-6" /> : <Crown className="h-6 w-6" />}
          </motion.div>
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl text-white">{copy.title}</DialogTitle>
            <DialogDescription className="text-white/85">{copy.body(tier)}</DialogDescription>
          </DialogHeader>
        </div>
        <div className="space-y-5 px-6 pb-6">
          <ul className="space-y-2.5 text-sm">
            {(reason === "quality" || reason === "downloads" ? MEDIA_BENEFITS : BENEFITS).map((b, i) => (
              <motion.li
                key={b.text}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.07 }}
                className="flex items-center gap-2.5"
              >
                <b.icon className="h-4 w-4 text-primary" /> {b.text}
              </motion.li>
            ))}
          </ul>
          <div className="flex flex-col gap-2">
            {offerFreeAccount ? (
              <>
                <Button asChild size="lg">
                  <Link href={signup}>Create free account</Link>
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <Link href="/pricing">Compare plans</Link>
                </Button>
              </>
            ) : (
              <>
                <Button asChild size="lg">
                  <Link href="/pricing">
                    <Zap /> Upgrade to Pro · ${PLANS.pro.priceMonthly}/mo
                  </Link>
                </Button>
                {guest && (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={signup}>Or create a free account</Link>
                  </Button>
                )}
              </>
            )}
            <button
              onClick={() => onOpenChange(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              "Not now"
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A quiet, dismissible card for success screens. */
export function UpsellCard({
  tier,
  onDismiss,
}: {
  tier: Tier;
  onDismiss: () => void;
}) {
  if (tier === "pro" || tier === "team") return null;
  const guest = tier === "guest";
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9, duration: 0.5 }}
      className="relative mx-auto mt-6 flex max-w-md items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 text-left"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        {guest ? <Cloud className="h-5 w-5" /> : <Crown className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{guest ? "Save your work to the cloud" : "Upgrade to Pro"}</p>
        <p className="text-muted-foreground">
          {guest ? (
            <>
              <Link href="/signup" className="font-medium text-primary hover:underline">Free account</Link> · cloud library · more AI
            </>
          ) : (
            <>
              <Link href="/pricing" className="font-medium text-primary hover:underline">Pro</Link> · {formatLimitBytes(LIMITS.pro.maxFileBytes)} files · unlimited library
            </>
          )}
        </p>
      </div>
      <button onClick={onDismiss} aria-label="Dismiss" className="rounded p-1 text-muted-foreground hover:bg-accent">
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}
