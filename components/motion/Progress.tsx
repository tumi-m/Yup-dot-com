import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { progressTranslate } from "./tokens";

/**
 * The one progress bar. Both states are CSS on the compositor, so the bar
 * keeps moving while the main thread is busy with the work it reports:
 * - indeterminate (no value yet): a soft sweep, or a still 35% bar with
 *   reduced motion;
 * - determinate: a full-width fill slid into place with transform, so updates
 *   never re-lay out the track and never repaint the gradient.
 */
export function ProgressBar({
  value,
  label,
  className,
}: {
  /** 0–1. Missing or tiny means "working, amount unknown". */
  value?: number | null;
  /** The accessible name. */
  label: string;
  /** Track size; defaults to the full-width 12px bar. */
  className?: string;
}) {
  const determinate = value != null && value > 0.02;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(value * 100) : undefined}
      className={cn("relative block h-3 overflow-hidden rounded-full bg-secondary", className)}
    >
      {determinate ? (
        // The fill slides in from the left while its gradient slides the
        // other way by the same amount, so the colours stay pinned to the
        // track (violet at the start, amber at the end) as it fills.
        <span
          className="absolute inset-0 overflow-hidden rounded-full transition-transform duration-progress ease-in-out motion-reduce:transition-none"
          style={{ transform: progressTranslate(value) }}
        >
          <span
            className="absolute inset-0 bg-gradient-to-r from-primary via-fuchsia-500 to-amber-400 transition-transform duration-progress ease-in-out motion-reduce:transition-none"
            style={{ transform: progressTranslate(value, -1) }}
          />
        </span>
      ) : (
        <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent motion-safe:animate-progress motion-reduce:w-full motion-reduce:bg-primary/35 motion-reduce:bg-none" />
      )}
    </span>
  );
}

/** The turning sparkle beside a working label; still with reduced motion. */
export function WorkingGlyph({ className }: { className?: string }) {
  return <Sparkles aria-hidden className={cn("h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-glyph", className)} />;
}
