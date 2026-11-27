"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Cloud, Crown, Disc3, FileType, Film, Globe, Infinity as InfinityIcon, Languages, Layers, Sparkles, Stamp, X, Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatLimitBytes, LIMITS, type Tier, type TierLimits } from "@/lib/limits";
import { PLANS, formatPrice } from "@/lib/plans";
import { displayPrice } from "@/lib/currency";
import { useLocalPrices } from "@/components/LocalPrice";
import { DUR, ENTER_T, NUDGE_DELAY_MS, SPRING, SUCCESS, staggerDelay } from "@/components/motion/tokens";
import { signupHref } from "@/components/auth-redirect";

export type UpsellReason = "file-size" | "batch" | "pages" | "redact-pages" | "ai" | "translate" | "translate-size" | "save" | "nudge" | "quality" | "downloads" | "edits" | "samples" | "office" | "office-size" | "web-pdfs";

const characters = (n: number) => `${n.toLocaleString("en-US")} characters`;

function translateBody(t: Tier) {
  return t === "guest"
    ? `${characters(LIMITS.free.translateCharsPerDay)} a day with a free account, ${characters(LIMITS.pro.translateCharsPerDay)} with Pro.`
    : `${characters(LIMITS.pro.translateCharsPerDay)} a day with Pro.`;
}

const COPY: Record<UpsellReason, { title: string; body: (tier: Tier) => string }> = {
  "file-size": {
    title: "File too large",
    body: (t) => `Free: ${formatLimitBytes(LIMITS[t].maxFileBytes)}. Pro: ${formatLimitBytes(LIMITS.pro.maxFileBytes)}.`,
  },
  batch: {
    title: "Too many files",
    body: (t) => `Free: ${LIMITS[t].maxBatchFiles} at once. Pro: ${LIMITS.pro.maxBatchFiles}.`,
  },
  pages: {
    title: "Too many pages to compare",
    body: (t) => `Free: ${LIMITS[t].comparePages} pages a file. Pro: ${LIMITS.pro.comparePages.toLocaleString("en-US")}.`,
  },
  "redact-pages": {
    title: "Too many pages to redact at once",
    body: (t) => `Free: ${LIMITS[t].redactPages} pages with marks at a time. Pro: ${LIMITS.pro.redactPages.toLocaleString("en-US")}.`,
  },
  ai: {
    title: "Daily AI limit reached",
    body: (t) =>
      t === "guest"
        ? `${LIMITS.free.aiAnswersPerDay} a day with a free account, ${LIMITS.pro.aiAnswersPerDay} with Pro.`
        : `${LIMITS.pro.aiAnswersPerDay} a day with Pro.`,
  },
  translate: {
    title: "Daily translation limit reached",
    body: (t) => translateBody(t),
  },
  // Before anything is used: the document is bigger than what's left today.
  "translate-size": {
    title: "This document needs more than you have left today",
    body: (t) => translateBody(t),
  },
  edits: {
    title: "You've used today's free edit",
    body: () => "Pro unlocks unlimited edits, no watermark.",
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
  "web-pdfs": {
    title: "Daily web page limit reached",
    body: (t) =>
      t === "guest"
        ? `${LIMITS.free.webPdfsPerDay} a day with a free account, ${LIMITS.pro.webPdfsPerDay} with Pro.`
        : `${LIMITS.pro.webPdfsPerDay} a day with Pro, up to ${LIMITS.pro.webPdfPages} pages each.`,
  },
  samples: {
    title: "Daily lookups used",
    body: (t) =>
      t === "guest"
        ? `${LIMITS.free.sampleLookupsPerDay} a day with a free account, ${LIMITS.pro.sampleLookupsPerDay} with Pro.`
        : `${LIMITS.pro.sampleLookupsPerDay} a day with Pro.`,
  },
  office: {
    title: "Daily conversion limit reached",
    body: (t) =>
      t === "guest"
        ? `${LIMITS.free.officeConversionsPerDay} Word and Excel files a day with a free account, ${LIMITS.pro.officeConversionsPerDay} with Pro.`
        : `${LIMITS.pro.officeConversionsPerDay} Word and Excel files a day with Pro.`,
  },
  "office-size": {
    title: "File too large",
    body: (t) => `Word and Excel files up to ${formatLimitBytes(LIMITS[t].officeMaxBytes)} free, ${formatLimitBytes(LIMITS.pro.officeMaxBytes)} with Pro.`,
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

/**
 * Pro and Team have the same limits, so at one of these there is nothing to
 * upgrade to: they are told the limit instead. Their other limits (AI
 * answers, downloads) come from the server, which offers no upgrade then,
 * and the dialog shows nothing for them.
 */
const PAID_LIMIT: Partial<Record<UpsellReason, (plan: string, limits: TierLimits) => string>> = {
  "file-size": (plan, l) => `Files up to ${formatLimitBytes(l.maxFileBytes)} on ${plan}.`,
  batch: (plan, l) => `Up to ${l.maxBatchFiles} files at once on ${plan}.`,
  pages: (plan, l) => `Up to ${l.comparePages.toLocaleString("en-US")} pages a file on ${plan}.`,
  "redact-pages": (plan, l) => `Up to ${l.redactPages.toLocaleString("en-US")} pages with marks at a time on ${plan}.`,
  // Translate PDF opens these only for guests and Free; should one reach Pro
  // or Team, it says when the day's allowance comes back, not "Upgrade".
  translate: (plan, l) => `${characters(l.translateCharsPerDay)} a day on ${plan}. More after midnight UTC.`,
  "translate-size": (plan, l) => `${characters(l.translateCharsPerDay)} a day on ${plan}. More after midnight UTC.`,
  office: (plan, l) => `${l.officeConversionsPerDay} Word and Excel files a day on ${plan}. More after midnight UTC.`,
  "office-size": (plan, l) => `Word and Excel files up to ${formatLimitBytes(l.officeMaxBytes)} on ${plan}.`,
  "web-pdfs": (plan, l) => `${l.webPdfsPerDay} web pages a day on ${plan}. More after midnight UTC.`,
};

/** What the dialog tells a Pro or Team user at this limit; null for other tiers (they get the upgrade) and other reasons. */
export function paidLimitNote(reason: UpsellReason, tier: Tier): string | null {
  if (tier !== "pro" && tier !== "team") return null;
  return PAID_LIMIT[reason]?.(PLANS[tier].name, LIMITS[tier]) ?? null;
}

const MEDIA_BENEFITS = [
  { icon: Film, text: "1080p downloads" },
  { icon: InfinityIcon, text: `${LIMITS.pro.mediaDownloadsPerDay} downloads a day` },
  { icon: Sparkles, text: "Bigger files, more AI" },
];

const SAMPLE_BENEFITS = [
  { icon: Disc3, text: `${LIMITS.pro.sampleLookupsPerDay} song lookups a day` },
  { icon: Film, text: "1080p downloads" },
  { icon: Sparkles, text: "Bigger files, more AI" },
];

const EDIT_BENEFITS = [
  { icon: InfinityIcon, text: "Unlimited edits" },
  { icon: Stamp, text: "No watermark" },
  { icon: Sparkles, text: "Bigger files, more AI" },
];

const TRANSLATE_BENEFITS = [
  { icon: Languages, text: `${characters(LIMITS.pro.translateCharsPerDay)} translated a day` },
  { icon: InfinityIcon, text: "Bigger files and batches" },
  { icon: Sparkles, text: "More AI answers" },
];

const OFFICE_BENEFITS = [
  { icon: FileType, text: `${LIMITS.pro.officeConversionsPerDay} Word and Excel files a day, up to ${formatLimitBytes(LIMITS.pro.officeMaxBytes)}` },
  { icon: InfinityIcon, text: "Bigger files and batches" },
  { icon: Sparkles, text: "More AI answers" },
];

const WEB_PDF_BENEFITS = [
  { icon: Globe, text: `${LIMITS.pro.webPdfsPerDay} web pages a day` },
  { icon: Layers, text: `Up to ${LIMITS.pro.webPdfPages} pages each` },
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
  // Guests are first offered the free account, unless it wouldn't help
  // (Free has the same file size, batch, quality and edit limits).
  const offerFreeAccount = guest && !["file-size", "batch", "quality", "edits", "office-size"].includes(reason);
  const signup = signupHref(returnTo);
  // Pro and Team: the limit, and nothing to buy.
  const paid = tier === "pro" || tier === "team";
  const paidNote = paidLimitNote(reason, tier);
  const prices = useLocalPrices(open && !paid);
  const pro = PLANS.pro.priceMonthly;

  // Most callers unmount the dialog as soon as it reports closed, which
  // would cut its exit animation. So it closes itself first and reports
  // once the animation has had time to play.
  const [shown, setShown] = useState(open);
  useEffect(() => setShown(open), [open]);
  function handleOpenChange(next: boolean) {
    if (next) return onOpenChange(true);
    setShown(false);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => onOpenChange(false), reduce ? 0 : DUR.fast * 1000);
  }

  if (paid && !paidNote) return null;

  return (
    <Dialog open={shown} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-md overflow-x-hidden p-0"
        closeClassName="text-white/90 hover:bg-white/15 hover:text-white focus-visible:ring-white"
      >
        <div className="relative bg-gradient-to-br from-violet-600 via-fuchsia-600 to-amber-500 px-6 pb-8 pt-7 text-white">
          <motion.div
            initial={{ scale: 0.6, rotate: -12 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={SPRING}
            className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/20"
          >
            {offerFreeAccount ? <Sparkles className="h-6 w-6" /> : <Crown className="h-6 w-6" />}
          </motion.div>
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl text-white">{copy.title}</DialogTitle>
            <DialogDescription className="text-white/85">{paidNote ?? copy.body(tier)}</DialogDescription>
          </DialogHeader>
        </div>
        <div className="space-y-5 px-6 pb-6">
          {paidNote ? (
            <Button size="lg" className="w-full" onClick={() => handleOpenChange(false)}>
              OK
            </Button>
          ) : (
            <>
              <ul className="space-y-2.5 text-sm">
                {(reason === "quality" || reason === "downloads"
                  ? MEDIA_BENEFITS
                  : reason === "edits"
                    ? EDIT_BENEFITS
                    : reason === "samples"
                      ? SAMPLE_BENEFITS
                      : reason === "translate" || reason === "translate-size"
                        ? TRANSLATE_BENEFITS
                        : reason === "office" || reason === "office-size"
                          ? OFFICE_BENEFITS
                        : reason === "web-pdfs"
                          ? WEB_PDF_BENEFITS
                          : BENEFITS
            ).map((b, i) => (
                  <motion.li
                    key={b.text}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ ...ENTER_T, delay: DUR.tap + staggerDelay(i) }}
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
                    <Button asChild variant="ghost" className="h-11">
                      <Link href="/pricing">Compare plans</Link>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button asChild size="lg">
                      <Link href="/pricing">
                        <Zap /> Upgrade to Pro{prices ? ` · ${displayPrice(prices, pro)}/mo` : ""}
                      </Link>
                    </Button>
                    {prices && !prices.local && (
                      <p className="-mt-1 text-center text-xs text-muted-foreground">Billed as {formatPrice(pro)}</p>
                    )}
                    {guest && (
                      <Button asChild variant="ghost" className="h-11">
                        <Link href={signup}>Or create a free account</Link>
                      </Button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Asked before the card's link leaves a result that hasn't been downloaded. */
export const LEAVE_RESULT_PROMPT = "Leave without downloading your file? It isn't saved anywhere.";

/** A quiet, dismissible card for success screens. */
export function UpsellCard({
  tier,
  onDismiss,
  returnTo,
  unsaved = false,
}: {
  tier: Tier;
  onDismiss: () => void;
  /** Where sign-up comes back to: the tool. */
  returnTo?: string;
  /** The result hasn't been downloaded, so leaving would lose it. */
  unsaved?: boolean;
}) {
  if (tier === "pro" || tier === "team") return null;
  const guest = tier === "guest";
  const leave = (e: React.MouseEvent) => {
    if (unsaved && !window.confirm(LEAVE_RESULT_PROMPT)) e.preventDefault();
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...ENTER_T, delay: SUCCESS.upsell }}
      className="relative mx-auto mt-6 flex max-w-md items-center gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4 pr-12 text-left"
    >
      {/* No icon on phones, so the text keeps the width. */}
      <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground sm:flex">
        {guest ? <Cloud className="h-5 w-5" /> : <Crown className="h-5 w-5" />}
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold">{guest ? "Your documents on any device" : "Upgrade to Pro"}</p>
        <p className="text-muted-foreground">
          {guest ? (
            <>
              <Link
                href={signupHref(returnTo)}
                onClick={leave}
                className="-my-3 inline-flex min-h-11 items-center py-3 font-medium text-primary hover:underline"
              >
                Free account
              </Link>{" "}
              · cloud library · more AI
            </>
          ) : (
            <>
              <Link
                href="/pricing"
                onClick={leave}
                className="-my-3 inline-flex min-h-11 items-center py-3 font-medium text-primary hover:underline"
              >
                Pro
              </Link> · {formatLimitBytes(LIMITS.pro.maxFileBytes)} files · unlimited library
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  );
}

/**
 * The guest sign-up nudge after a finished task, timed so it never covers the
 * success moment: it opens after a quiet pause only if the visitor hasn't
 * touched anything, otherwise once they've downloaded the result.
 */
export function useSuccessNudge(open: () => void) {
  const openRef = useRef(open);
  openRef.current = open;
  const pending = useRef(false);
  const stop = useRef<(() => void) | null>(null);

  const disarm = useCallback(() => {
    pending.current = false;
    stop.current?.();
    stop.current = null;
  }, []);

  /** Call when the task finishes and a nudge is due. */
  const arm = useCallback(() => {
    disarm();
    pending.current = true;
    let idle = true;
    const timer = window.setTimeout(() => {
      if (idle && pending.current) {
        disarm();
        openRef.current();
      }
    }, NUDGE_DELAY_MS);
    const onInput = () => {
      idle = false;
      window.clearTimeout(timer);
    };
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    stop.current = () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
    };
  }, [disarm]);

  /** Call when the result is downloaded: a waiting nudge opens now. */
  const downloaded = useCallback(() => {
    if (!pending.current) return;
    disarm();
    // Kept in `stop`, so Start over, a next tool or leaving the page still cancels it.
    const timer = window.setTimeout(() => {
      stop.current = null;
      openRef.current();
    }, DUR.slow * 1000);
    stop.current = () => window.clearTimeout(timer);
  }, [disarm]);

  useEffect(() => disarm, [disarm]);
  return { arm, downloaded, cancel: disarm };
}
