import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { progressTranslate } from "./tokens";

/**
 * The one progress bar. Both states are CSS on the compositor, so the bar
 * keeps moving while the main thread is busy with the work it reports:
 * - indeterminate (no amount yet): a soft sweep, or a still faint bar with
 *   reduced motion;
 * - determinate: a full-width fill slid into place with transform, so updates
 *   never re-lay out the track and never repaint the gradient.
 * When the first amount arrives the sweep stops where it is and fades while
 * the fill grows out of the track's start, so the bar never cuts.
 */
export function ProgressBar({
  value,
  label,
  determinate: known = false,
  className,
}: {
  /** 0–1. Missing or tiny means "working, amount unknown" unless `determinate`. */
  value?: number | null;
  /** The accessible name. */
  label: string;
  /** The amount is known even at 0 (e.g. "slide 1 of 12"): no sweep. */
  determinate?: boolean;
  /** Track size; defaults to the full-width 12px bar. */
  className?: string;
}) {
  const amount = Math.min(1, Math.max(0, Number.isFinite(value) ? (value as number) : 0));
  const determinate = known || amount > 0.02;
  const fill = determinate ? amount : 0;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(amount * 100) : undefined}
      className={cn("relative block h-3 overflow-hidden rounded-full bg-secondary", className)}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent transition-opacity duration-fast ease-out motion-safe:animate-progress motion-reduce:w-full motion-reduce:bg-primary/35 motion-reduce:bg-none motion-reduce:transition-none",
          determinate && "opacity-0 motion-safe:[animation-play-state:paused]"
        )}
      />
      {/* The fill slides in from the left while its gradient slides the other
          way by the same amount, so the colours stay pinned to the track
          (violet at the start, amber at the end) as it fills. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 overflow-hidden rounded-full transition-[transform,opacity] duration-progress ease-out motion-reduce:transition-none",
          !determinate && "opacity-0"
        )}
        style={{ transform: progressTranslate(fill) }}
      >
        <span
          className="absolute inset-0 bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400 transition-transform duration-progress ease-out motion-reduce:transition-none"
          style={{ transform: progressTranslate(fill, -1) }}
        />
      </span>
    </span>
  );
}

/**
 * The percentage beside a progress label, in a box as wide as "100%", so the
 * label next to it never moves as the number grows. Empty until there is a
 * number.
 */
export function ProgressPercent({ value }: { value?: number | null }) {
  return (
    <span className="inline-block w-[4.6ch] text-left tabular-nums">
      {value != null && value > 0.02 ? `${Math.round(Math.min(1, value) * 100)}%` : ""}
    </span>
  );
}

/** The turning sparkle beside a working label; still with reduced motion. */
export function WorkingGlyph({ className }: { className?: string }) {
  return <Sparkles aria-hidden className={cn("h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-glyph", className)} />;
}
